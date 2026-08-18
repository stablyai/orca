import { normalizeExecutionHostId, type ParsedExecutionHost } from '../shared/execution-host'
import type { ProjectHostSetup } from '../shared/project-types'
import { hostFilterMatchesHostId, parseHostFlag } from './execution-host-flag'
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
function findReadySetupOnHost(
  setups: readonly ProjectHostSetup[],
  projectId: string | undefined,
  host: ParsedExecutionHost | undefined
): ProjectHostSetup | undefined {
  const candidates = setups.filter((candidate) => candidate.projectId === projectId)
  if (!host) {
    return candidates[0]
  }
  return (
    candidates.find((candidate) => normalizeExecutionHostId(candidate.hostId) === host.id) ??
    candidates.find((candidate) => hostFilterMatchesHostId(host, candidate.hostId))
  )
}

export async function resolveProjectCreateTarget(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<ProjectCreateTarget | undefined> {
  const projectHostSetupId = getPresentStringFlag(flags, 'project-host-setup')
  const projectId = getPresentStringFlag(flags, 'project')
  const host = parseHostFlag(flags)
  if (!projectHostSetupId && !projectId && !host) {
    return undefined
  }
  const result = await client.call<{ setups: ProjectHostSetup[] }>('projectHostSetup.list')
  const ready = result.result.setups.filter((candidate) => candidate.setupState === 'ready')
  const setup = projectHostSetupId
    ? ready.find((candidate) => candidate.id === projectHostSetupId)
    : findReadySetupOnHost(ready, projectId, host)
  if (!setup) {
    throw new RuntimeClientError(
      'invalid_argument',
      projectHostSetupId
        ? `Project host setup is not ready or was not found: ${projectHostSetupId}`
        : `Project is not set up on the selected host: ${projectId}${host ? ` on ${host.id}` : ''}`
    )
  }
  return {
    repoSelector: `id:${setup.repoId}`,
    setup
  }
}
