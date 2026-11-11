import { normalizeExecutionHostId } from '../shared/execution-host'
import type { Project, ProjectHostSetup } from '../shared/project-types'
import { normalizeTypedName } from './host-selector-alternatives'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'

function matchesName(value: string | undefined, selector: string): boolean {
  return value !== undefined && normalizeTypedName(value) === normalizeTypedName(selector)
}

export function setupHostId(setup: ProjectHostSetup): string {
  return normalizeExecutionHostId(setup.hostId) ?? setup.hostId
}

export async function findProjectSetups(
  client: RuntimeClient,
  setups: readonly ProjectHostSetup[],
  projectSelector: string
): Promise<ProjectHostSetup[]> {
  const byId = setups.filter((candidate) => candidate.projectId === projectSelector)
  if (byId.length > 0) {
    return byId
  }
  const projects = await listProjectsUnlessUnsupported(client)
  if (projects === null) {
    return legacyNameMatchedSetups(setups, projectSelector)
  }
  // An exact id must not fall through to another project whose name equals it.
  if (projects.some((project) => project.id === projectSelector)) {
    return []
  }
  const named = projects.filter((project) => matchesName(project.displayName, projectSelector))
  assertProjectNameUnambiguous(named, projectSelector)
  const matchedId = named[0]?.id
  return matchedId === undefined
    ? []
    : setups.filter((candidate) => candidate.projectId === matchedId)
}

/** Unknown selectors pass through for the server to resolve. */
export async function resolveProjectIdSelector(
  client: RuntimeClient,
  projectSelector: string
): Promise<string> {
  let projects: Project[]
  try {
    projects = (await client.call<{ projects: Project[] }>('project.list')).result.projects
  } catch {
    // Failed name lookup must not prevent a valid id from reaching the server.
    return projectSelector
  }
  if (projects.some((project) => project.id === projectSelector)) {
    return projectSelector
  }
  const named = projects.filter((project) => matchesName(project.displayName, projectSelector))
  assertProjectNameUnambiguous(named, projectSelector)
  return named[0]?.id ?? projectSelector
}

function assertProjectNameUnambiguous(named: readonly Project[], projectSelector: string): void {
  if (named.length <= 1) {
    return
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `Ambiguous --project ${projectSelector}: ${named.length} projects are named that. Use the project id.`,
    {
      knownProjects: named.map((project) => ({ id: project.id, name: project.displayName })),
      nextSteps: named.map((project) => `Use --project ${project.id} for ${project.displayName}.`)
    }
  )
}

// Older servers expose only setup display names, which name repos rather than projects.
function legacyNameMatchedSetups(
  setups: readonly ProjectHostSetup[],
  projectSelector: string
): ProjectHostSetup[] {
  const matched = setups.filter((candidate) => matchesName(candidate.displayName, projectSelector))
  const projectIds = [...new Set(matched.map((candidate) => candidate.projectId))]
  // Repo folder names can collide across projects; never guess between them.
  if (projectIds.length <= 1) {
    return matched
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `Ambiguous --project ${projectSelector}: ${projectIds.length} projects have a setup named that. Use the project id.`,
    {
      knownProjects: projectIds.map((id) => ({ id })),
      nextSteps: projectIds.map((id) => `Use --project ${id}.`)
    }
  )
}

/** Null when the server has no project.list at all, as opposed to no matching project. */
async function listProjectsUnlessUnsupported(client: RuntimeClient): Promise<Project[] | null> {
  try {
    return (await client.call<{ projects: Project[] }>('project.list')).result.projects
  } catch (error) {
    // Only a version gap permits the weaker name match; propagate network and permission failures.
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      return null
    }
    throw error
  }
}
