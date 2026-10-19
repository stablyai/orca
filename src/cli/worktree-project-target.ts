import { normalizeExecutionHostId, type ParsedExecutionHost } from '../shared/execution-host'
import type { ProjectHostSetup } from '../shared/project-types'
import { hostFilterMatchesHostId, resolveHostFlagTarget } from './execution-host-flag'
import { findProjectSetups, setupHostId } from './project-selector'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'

export type ProjectCreateTarget = {
  repoSelector: string
  setup: ProjectHostSetup
}

function getPresentStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = flags.get(name)
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing value for --${name}`)
}

export function hasWorkspaceProjectTarget(flags: Map<string, string | boolean>): boolean {
  return flags.has('project') || flags.has('host') || flags.has('project-host-setup')
}

export function assertWorkspaceTargetFlagsCompatible(flags: Map<string, string | boolean>): void {
  const hasProjectTarget = hasWorkspaceProjectTarget(flags)
  if (flags.has('repo') && hasProjectTarget) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Choose either --repo or project target flags, not both.'
    )
  }
  if (flags.has('host') && !flags.has('project') && !flags.has('project-host-setup')) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--host requires --project unless --project-host-setup is provided.'
    )
  }
}

export async function resolveProjectCreateRepoSelector(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<string | undefined> {
  return (await resolveProjectCreateTarget(flags, client))?.repoSelector
}

// Why: the routed runtime can hold both an exact `runtime:<id>` row and a `local` row for the
// same project; the exact stamp is the one the caller named, so it wins the selection.
function selectSetupOnHost(
  candidates: readonly ProjectHostSetup[],
  host: ParsedExecutionHost | undefined,
  projectSelector: string | undefined
): ProjectHostSetup | undefined {
  if (host) {
    return (
      candidates.find((candidate) => normalizeExecutionHostId(candidate.hostId) === host.id) ??
      candidates.find((candidate) => hostFilterMatchesHostId(host, candidate.hostId))
    )
  }
  // Why: one host is not a choice, so demanding --host for it was ceremony. Two are a choice, and
  // picking one would run the command on a machine the caller never named.
  const hostIds = new Set(candidates.map(setupHostId))
  if (hostIds.size <= 1 || projectSelector === undefined) {
    return candidates[0]
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `Ambiguous --project ${projectSelector}: it is set up on ${hostIds.size} hosts. Pass --host to choose one.`,
    {
      knownProjectHostSetups: candidates.map(summarizeSetup),
      nextSteps: [
        ...candidates.map(
          (candidate) => `Use --host ${setupHostId(candidate)} for ${candidate.path}.`
        ),
        'Run `orca host list` to see every machine you can target and the flag for each.'
      ]
    }
  )
}

function summarizeSetup(setup: ProjectHostSetup): {
  id: string
  hostId: string
  path: string
} {
  return { id: setup.id, hostId: setupHostId(setup), path: setup.path }
}

export async function resolveProjectCreateTarget(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<ProjectCreateTarget | undefined> {
  const projectHostSetupId = getPresentStringFlag(flags, 'project-host-setup')
  const projectId = getPresentStringFlag(flags, 'project')
  const host = await resolveHostFlagTarget(flags, client)
  if (!projectHostSetupId && !projectId && !host) {
    return undefined
  }
  let result: Awaited<ReturnType<typeof client.call<{ setups: ProjectHostSetup[] }>>>
  try {
    result = await client.call<{ setups: ProjectHostSetup[] }>('projectHostSetup.list')
  } catch (error) {
    // Why: --host runtime:<id> routes here, so an older server is reachable without the caller
    // meaning to; name the version gap rather than surfacing a raw method_not_found.
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca server does not support project host setup yet. Update Orca on the server and try again.'
      )
    }
    throw error
  }
  const ready = result.result.setups.filter((candidate) => candidate.setupState === 'ready')
  // Match against every setup so an exact id with no ready setup never falls through to a name.
  const candidates =
    projectId === undefined || projectHostSetupId
      ? []
      : (await findProjectSetups(client, result.result.setups, projectId)).filter(
          (candidate) => candidate.setupState === 'ready'
        )
  const setup = projectHostSetupId
    ? ready.find((candidate) => candidate.id === projectHostSetupId)
    : selectSetupOnHost(candidates, host, projectId)
  if (!setup) {
    if (projectHostSetupId) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Project host setup is not ready or was not found: ${projectHostSetupId}`
      )
    }
    // Why: blaming the host when no project matched sent callers to debug the wrong flag.
    if (candidates.length === 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        `No ready setup found for --project ${projectId} on any host.`,
        {
          nextSteps: [
            'Run `orca project list` for project ids and names, and `orca project setups` for where each is set up.'
          ]
        }
      )
    }
    throw new RuntimeClientError(
      'invalid_argument',
      `Project is not set up on the selected host: ${projectId}${host ? ` on ${host.id}` : ''}`,
      // Why: when the project is set up somewhere just not here, the recoverable answer is which
      // hosts do have it — otherwise the caller has to go re-derive the listing by hand.
      {
        knownProjectHostSetups: candidates.map(summarizeSetup),
        nextSteps: candidates.map(
          (candidate) => `Use --host ${setupHostId(candidate)} for ${candidate.path}.`
        )
      }
    )
  }
  return {
    repoSelector: `id:${setup.repoId}`,
    setup
  }
}

// Why the worktree id, not the selector: a host-scoped `identity:` selector carries no repo id.
function getRepoSelectorFromWorktreeId(worktreeId: string | undefined): string | undefined {
  const separatorIndex = worktreeId?.indexOf('::') ?? -1
  if (!worktreeId || separatorIndex <= 0) {
    return undefined
  }
  return `id:${worktreeId.slice(0, separatorIndex)}`
}

export async function getCreateRepoSelector(
  flags: Map<string, string | boolean>,
  cwdParentWorktree: { worktreeId: string } | undefined,
  client: RuntimeClient
): Promise<string> {
  const projectRepoSelector = await resolveProjectCreateRepoSelector(flags, client)
  if (projectRepoSelector) {
    return projectRepoSelector
  }
  const explicitRepo = getPresentStringFlag(flags, 'repo')
  if (explicitRepo) {
    return explicitRepo
  }
  const inferredRepo = getRepoSelectorFromWorktreeId(cwdParentWorktree?.worktreeId)
  if (inferredRepo) {
    return inferredRepo
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'Missing repo selector. Pass --repo or run from inside an Orca-managed worktree.'
  )
}
