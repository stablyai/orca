import type { RuntimeClient } from './runtime-client'
import { normalizeTypedName, stripWrappingQuotes } from '../shared/typed-name-normalization'

export type SshTargetSummary = {
  id: string
  label: string
  remotePlatform?: 'linux' | 'darwin' | 'win32'
  connected?: boolean
  connectionStatus?: string
}
export type EnvironmentSummary = { id: string; name: string }

export const LOCAL_HOST_LIST_NAME = 'this machine'

export type HostAlternatives = {
  sshTargets: readonly SshTargetSummary[]
  environments: readonly EnvironmentSummary[]
}

export function findSshTargetByName(
  targets: readonly SshTargetSummary[],
  name: string
): SshTargetSummary | undefined {
  const byId = targets.find((target) => target.id === name)
  if (byId) {
    return byId
  }
  const byLabel = matchesByLabel(targets, name)
  return byLabel.length === 1 ? byLabel[0] : undefined
}

export { normalizeTypedName, stripWrappingQuotes }

function matchesByLabel(targets: readonly SshTargetSummary[], name: string): SshTargetSummary[] {
  const wanted = normalizeTypedName(name)
  return targets.filter((target) => normalizeTypedName(target.label) === wanted)
}

export function ambiguousSshTargets(
  targets: readonly SshTargetSummary[],
  name: string
): SshTargetSummary[] {
  const byLabel = matchesByLabel(targets, name)
  return byLabel.length > 1 ? byLabel : []
}

export function findEnvironmentByName(
  environments: readonly EnvironmentSummary[],
  name: string
): EnvironmentSummary | undefined {
  const byId = environments.find((environment) => environment.id === name)
  if (byId) {
    return byId
  }
  const byName = matchesByEnvironmentName(environments, name)
  return byName.length === 1 ? byName[0] : undefined
}

function matchesByEnvironmentName(
  environments: readonly EnvironmentSummary[],
  name: string
): EnvironmentSummary[] {
  const wanted = normalizeTypedName(name)
  return environments.filter((environment) => normalizeTypedName(environment.name) === wanted)
}

export function ambiguousEnvironments(
  environments: readonly EnvironmentSummary[],
  name: string
): EnvironmentSummary[] {
  const byName = matchesByEnvironmentName(environments, name)
  return byName.length > 1 ? byName : []
}

export function crossKindNextSteps(
  name: string,
  alternatives: HostAlternatives,
  requested: 'environment' | 'ssh'
): string[] {
  const steps: string[] = []
  const ssh = findSshTargetByName(alternatives.sshTargets, name)
  const environment = findEnvironmentByName(alternatives.environments, name)
  if (requested !== 'ssh' && ssh) {
    steps.push(
      `"${name}" is an SSH target on this Orca host, not a paired server. Use --host ssh:${ssh.id}.`
    )
  }
  if (requested !== 'environment' && environment) {
    steps.push(
      `"${name}" is a paired Orca server, not an SSH target. Use --environment ${environment.name}.`
    )
  }
  return steps
}

/** Older hosts expose summaries through listTargets; propagate errors other than method_not_found. */
export async function fetchSshTargetSummaries<T extends { id: string }>(
  client: RuntimeClient
): Promise<{ targets: T[]; legacy: boolean }> {
  try {
    const result = await client.call<{ targets: T[] }>('ssh.listTargetSummaries')
    return { targets: result.result.targets, legacy: false }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'method_not_found')) {
      throw error
    }
    const legacy = await client.call<{ targets: T[] }>('ssh.listTargets')
    return { targets: legacy.result.targets, legacy: true }
  }
}

// Best-effort discovery avoids replacing selector errors with SSH enumeration failures.
export async function listSshTargets(client: RuntimeClient): Promise<SshTargetSummary[]> {
  try {
    const { targets, legacy } = await fetchSshTargetSummaries<SshTargetSummary>(client)
    return legacy ? await enrichLegacySshTargetStates(client, targets) : targets
  } catch {
    return []
  }
}

async function enrichLegacySshTargetStates(
  client: RuntimeClient,
  targets: SshTargetSummary[]
): Promise<SshTargetSummary[]> {
  return Promise.all(
    targets.map(async (target) => {
      try {
        const response = await client.call<{
          state: {
            status?: string
            remotePlatform?: 'linux' | 'darwin' | 'win32'
          } | null
        }>('ssh.getState', { targetId: target.id })
        const state = response.result.state
        return {
          ...target,
          ...(state?.status === undefined
            ? {}
            : { connected: state.status === 'connected', connectionStatus: state.status }),
          ...(state?.remotePlatform === undefined ? {} : { remotePlatform: state.remotePlatform })
        }
      } catch {
        return target
      }
    })
  )
}

export async function resolveSshHostTargetId(
  client: RuntimeClient,
  targetId: string,
  environments: readonly EnvironmentSummary[],
  flagSpelling = `--host ssh:${targetId}`,
  bareName = false
): Promise<string> {
  const targets = await listSshTargets(client)
  const matched = findSshTargetByName(targets, targetId)
  if (matched) {
    return matched.id
  }
  const { RuntimeClientError } = await import('./runtime/types.js')
  const ambiguous = ambiguousSshTargets(targets, targetId)
  if (ambiguous.length > 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Ambiguous SSH target in ${flagSpelling}: ${ambiguous.length} targets share that label. Use the target id.`,
      {
        knownSshTargets: ambiguous,
        nextSteps: ambiguous.map((target) => `Use --host ssh:${target.id} for ${target.label}.`)
      }
    )
  }
  throw new RuntimeClientError(
    'invalid_argument',
    bareName
      ? `Unknown host in ${flagSpelling}: it is not this machine or a paired Orca server the command can use, and the connected Orca host has no SSH target named ${targetId}. Run \`orca host list\` to see every name.`
      : `Unknown SSH target in ${flagSpelling}: this Orca host has no SSH target named or with id ${targetId}.`,
    {
      knownSshTargets: targets,
      knownEnvironments: environments,
      nextSteps: [
        ...crossKindNextSteps(targetId, { sshTargets: targets, environments }, 'ssh'),
        ...(targets.length > 0
          ? [`Known SSH targets: ${targets.map((target) => target.label).join(', ')}.`]
          : ['This Orca host has no SSH targets registered.'])
      ]
    }
  )
}
