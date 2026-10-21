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

// Why: `orca project list` shows display names, and the stored projectId is a provider-scoped
// string ("github:stablyai/orca") nobody keeps in their head — so the name is what gets typed.
// Matching ids alone reported "not set up" for a project sitting right there in the listing.
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
  // Why: an exact id with no setups names that project, not another one whose name equals it.
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

/**
 * The project id a `--project` value names, for commands that send the id itself. An id or an
 * unknown value passes through unchanged so the server still answers for it, as it always did.
 */
export async function resolveProjectIdSelector(
  client: RuntimeClient,
  projectSelector: string
): Promise<string> {
  let projects: Project[]
  try {
    projects = (await client.call<{ projects: Project[] }>('project.list')).result.projects
  } catch {
    // Why: falling back sends the value exactly as before this lookup existed, so a failed or
    // missing project.list costs only the name convenience, never a working id.
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

// Why: a server predating project.list still answers projectHostSetup.list, and those rows carry
// a display name of their own. It is the repo's name rather than the project's, so this is the
// weaker match — reachable only on that older server.
function legacyNameMatchedSetups(
  setups: readonly ProjectHostSetup[],
  projectSelector: string
): ProjectHostSetup[] {
  const matched = setups.filter((candidate) => matchesName(candidate.displayName, projectSelector))
  const projectIds = [...new Set(matched.map((candidate) => candidate.projectId))]
  // Why: two projects can hold repos with the same folder name, and this match is by folder name.
  // Selecting either would target a project the caller did not name.
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
    // Why: only a version gap justifies the weaker fallback. Swallowing everything reported a
    // network blip or a permission error as "no project by that name", which then surfaced as
    // "Project is not set up on the selected host" for a project that exists and is set up.
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      return null
    }
    throw error
  }
}
