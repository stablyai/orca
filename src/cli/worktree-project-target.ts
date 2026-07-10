import type { ProjectHostSetup } from '../shared/types'
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

export async function resolveProjectCreateTarget(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<ProjectCreateTarget | undefined> {
  const projectHostSetupId = getPresentStringFlag(flags, 'project-host-setup')
  const projectId = getPresentStringFlag(flags, 'project')
  const hostId = getPresentStringFlag(flags, 'host')
  if (!projectHostSetupId && !projectId && !hostId) {
    return undefined
  }
  const result = await client.call<{ setups: ProjectHostSetup[] }>('projectHostSetup.list')
  const setup = result.result.setups.find((candidate) => {
    if (candidate.setupState !== 'ready') {
      return false
    }
    if (projectHostSetupId) {
      return candidate.id === projectHostSetupId
    }
    return (
      candidate.projectId === projectId && (hostId === undefined || candidate.hostId === hostId)
    )
  })
  if (!setup) {
    throw new RuntimeClientError(
      'invalid_argument',
      projectHostSetupId
        ? `Project host setup is not ready or was not found: ${projectHostSetupId}`
        : `Project is not set up on the selected host: ${projectId}${hostId ? ` on ${hostId}` : ''}`
    )
  }
  return {
    repoSelector: `id:${setup.repoId}`,
    setup
  }
}
