/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import globSync from 'glob';
import path from 'path';
import { promisify } from 'util';

import { CliError } from './errors';
import { Project } from './project';

const glob = promisify(globSync);

export type ProjectMap = Map<string, Project>;
export type ProjectGraph = Map<string, Project[]>;
export interface IProjectsOptions {
  include?: string[];
  exclude?: string[];
}

export async function getProjects(
  rootPath: string,
  projectsPathsPatterns: string[],
  { include = [], exclude = [] }: IProjectsOptions = {}
) {
  const projects: ProjectMap = new Map();

  for (const pattern of projectsPathsPatterns) {
    const pathsToProcess = await packagesFromGlobPattern({ pattern, rootPath });

    for (const filePath of pathsToProcess) {
      const projectConfigPath = normalize(filePath);
      const projectDir = path.dirname(projectConfigPath);
      const project = await Project.fromPath(projectDir);

      const excludeProject =
        exclude.includes(project.name) ||
        (include.length > 0 && !include.includes(project.name));

      if (excludeProject) {
        continue;
      }

      if (projects.has(project.name)) {
        throw new CliError(
          `There are multiple projects with the same name [${project.name}]`,
          {
            name: project.name,
            paths: [project.path, projects.get(project.name)!.path],
          }
        );
      }

      projects.set(project.name, project);
    }
  }

  return projects;
}

function packagesFromGlobPattern({
  pattern,
  rootPath,
}: {
  pattern: string;
  rootPath: string;
}) {
  const globOptions = {
    cwd: rootPath,

    // Should throw in case of unusual errors when reading the file system
    strict: true,

    // Always returns absolute paths for matched files
    absolute: true,

    // Do not match ** against multiple filenames
    // (This is only specified because we currently don't have a need for it.)
    noglobstar: true,
  };

  return glob(path.join(pattern, 'package.json'), globOptions);
}

// https://github.com/isaacs/node-glob/blob/master/common.js#L104
// glob always returns "\\" as "/" in windows, so everyone
// gets normalized because we can't have nice things.
function normalize(dir: string) {
  return path.normalize(dir);
}

export function buildProjectGraph(projects: ProjectMap) {
  const projectGraph: ProjectGraph = new Map();

  for (const project of projects.values()) {
    const projectDeps = [];
    const dependencies = project.allDependencies;

    for (const depName of Object.keys(dependencies)) {
      if (projects.has(depName)) {
        const dep = projects.get(depName)!;

        project.ensureValidProjectDependency(dep);

        projectDeps.push(dep);
      }
    }

    projectGraph.set(project.name, projectDeps);
  }

  return projectGraph;
}

export function topologicallyBatchProjects(
  projectsToBatch: ProjectMap,
  projectGraph: ProjectGraph
) {
  // We're going to be chopping stuff out of this list, so copy it.
  const projectToBatchNames = new Set(projectsToBatch.keys());

  const batches = [];
  while (projectToBatchNames.size > 0) {
    // Get all projects that have no remaining dependencies within the repo
    // that haven't yet been picked.
    const batch = [];
    for (const projectName of projectToBatchNames) {
      const projectDeps = projectGraph.get(projectName)!;
      const hasNotBatchedDependencies = projectDeps.some(dep =>
        projectToBatchNames.has(dep.name)
      );

      if (!hasNotBatchedDependencies) {
        batch.push(projectsToBatch.get(projectName)!);
      }
    }

    // If we weren't able to find a project with no remaining dependencies,
    // then we've encountered a cycle in the dependency graph.
    const hasCycles = batch.length === 0;
    if (hasCycles) {
      const cycleProjectNames = [...projectToBatchNames];
      const message =
        'Encountered a cycle in the dependency graph. Projects in cycle are:\n' +
        cycleProjectNames.join(', ');

      throw new CliError(message);
    }

    batches.push(batch);

    batch.forEach(project => projectToBatchNames.delete(project.name));
  }

  return batches;
}

export function includeTransitiveProjects(
  subsetOfProjects: Project[],
  allProjects: ProjectMap,
  { onlyProductionDependencies = false } = {}
) {
  const dependentProjects: ProjectMap = new Map();

  // the current list of packages we are expanding using breadth-first-search
  const toProcess = [...subsetOfProjects];

  while (toProcess.length > 0) {
    const project = toProcess.shift()!;

    const dependencies = onlyProductionDependencies
      ? project.productionDependencies
      : project.allDependencies;

    Object.keys(dependencies).forEach(dep => {
      if (allProjects.has(dep)) {
        toProcess.push(allProjects.get(dep)!);
      }
    });

    dependentProjects.set(project.name, project);
  }

  return dependentProjects;
}