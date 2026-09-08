import type { RuntimeClient } from './runtime-client'
import { mapWithConcurrency } from '../shared/map-with-concurrency'
import { z } from 'zod'

export type SshTargetSummary = {
  id: string
  label: string
  remotePlatform?: 'linux' | 'darwin' | 'win32'
  connected?: boolean
  connectionStatus?: string
}
export type EnvironmentSummary = { id: string; name: string }

export type HostAlternatives = {
  sshTargets: readonly SshTargetSummary[]
  environments: readonly EnvironmentSummary[]
}

// Why: SSH target ids are machine-generated (`ssh-<timestamp>-<random>`), so the name a person
// or an agent actually knows is the label. Looking a name up as an id alone reports "not found"
// for a target that is sitting right there.
export function findSshTargetByName(
  targets: readonly SshTargetSummary[],
  name: string
): SshTargetSummary | undefined {
  const byId = targets.find((target) => target.id === name)
  if (byId) {
    return byId
  }
  const byLabel = matchesByLabel(targets, name)
  // Why: two targets can share a label. Picking the first would silently choose a machine for
  // the caller — the failure this whole selector path exists to prevent — so an ambiguous name
  // resolves to nothing and the caller is told to use an id.
  return byLabel.length === 1 ? byLabel[0] : undefined
}

function matchesByLabel(targets: readonly SshTargetSummary[], name: string): SshTargetSummary[] {
  const wanted = name.trim().toLowerCase()
  return targets.filter((target) => target.label.trim().toLowerCase() === wanted)
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
  // Why: the environment store itself refuses an ambiguous name rather than guessing; resolving
  // one here would quietly reintroduce the guess it exists to prevent.
  return byName.length === 1 ? byName[0] : undefined
}

function matchesByEnvironmentName(
  environments: readonly EnvironmentSummary[],
  name: string
): EnvironmentSummary[] {
  const wanted = name.trim().toLowerCase()
  return environments.filter((environment) => environment.name.trim().toLowerCase() === wanted)
}

export function ambiguousEnvironments(
  environments: readonly EnvironmentSummary[],
  name: string
): EnvironmentSummary[] {
  const byName = matchesByEnvironmentName(environments, name)
  return byName.length > 1 ? byName : []
}

// Why: a paired Orca server and an SSH target are different machines reached different ways, but
// a caller only knows "the machine called X". When X misses on one axis, the useful answer is
// almost always that it exists on the other — so say which, and give the exact flag.
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

// Why: only display identity crosses this boundary — the RPC deliberately withholds addresses
// and credentials — and an enumeration failure must never mask the error we are explaining.
export type SshInventoryOptions = { strict?: boolean; signal?: AbortSignal; deadline?: number }

function inventoryCallOptions(options?: SshInventoryOptions): {
  signal?: AbortSignal
  timeoutMs?: number
} {
  if (options?.signal?.aborted) {
    throw options.signal.reason
  }
  const remaining = options?.deadline === undefined ? undefined : options.deadline - Date.now()
  if (remaining !== undefined && remaining <= 0) {
    throw new Error('SSH inventory deadline exceeded.')
  }
  return { signal: options?.signal, timeoutMs: remaining }
}

const SshTargetSummariesSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(512),
      label: z.string().max(512),
      connected: z.boolean().optional(),
      connectionStatus: z.string().max(128).optional(),
      remotePlatform: z.enum(['linux', 'darwin', 'win32']).optional()
    })
  )
  .max(4096)

export async function listSshTargets(
  client: RuntimeClient,
  options?: SshInventoryOptions
): Promise<SshTargetSummary[]> {
  try {
    const result = await client.call<{ targets: SshTargetSummary[] }>(
      'ssh.listTargetSummaries',
      ...(options ? ([undefined, inventoryCallOptions(options)] as const) : [])
    )
    return options?.strict
      ? SshTargetSummariesSchema.parse(result.result.targets)
      : result.result.targets
  } catch (error) {
    // Why: hosts predating listTargetSummaries still answer listTargets, and both are served by
    // the same summariser. Without this an old host looks like one with no SSH targets at all,
    // which would reject a target id that is actually valid there.
    if (error instanceof Error && 'code' in error && error.code === 'method_not_found') {
      try {
        const legacy = await client.call<{ targets: SshTargetSummary[] }>(
          'ssh.listTargets',
          ...(options ? ([undefined, inventoryCallOptions(options)] as const) : [])
        )
        return await enrichLegacySshTargetStates(
          client,
          options?.strict
            ? SshTargetSummariesSchema.parse(legacy.result.targets)
            : legacy.result.targets,
          options
        )
      } catch (legacyError) {
        if (options?.strict) {
          throw legacyError
        }
        return []
      }
    }
    if (options?.strict) {
      throw error
    }
    return []
  }
}

async function enrichLegacySshTargetStates(
  client: RuntimeClient,
  targets: SshTargetSummary[],
  options?: SshInventoryOptions
): Promise<SshTargetSummary[]> {
  return mapWithConcurrency(targets, 3, async (target) => {
    if (
      options?.signal?.aborted ||
      (options?.deadline !== undefined && Date.now() >= options.deadline)
    ) {
      return { ...target, connected: undefined, connectionStatus: 'unknown' }
    }
    try {
      const response = await client.call<{
        state: { status?: string; remotePlatform?: 'linux' | 'darwin' | 'win32' } | null
      }>(
        'ssh.getState',
        { targetId: target.id },
        ...(options ? ([inventoryCallOptions(options)] as const) : [])
      )
      const state = response.result.state
      return {
        ...target,
        ...(state?.status !== undefined
          ? { connected: state.status === 'connected', connectionStatus: state.status }
          : options?.strict
            ? { connected: undefined, connectionStatus: 'unknown' }
            : {}),
        ...(state?.remotePlatform ? { remotePlatform: state.remotePlatform } : {})
      }
    } catch {
      return { ...target, connected: undefined, connectionStatus: 'unknown' }
    }
  })
}

// Why: `--host ssh:<id>` was never validated, so an unknown target answered ok:true with an
// empty list — the same silent wrong-machine answer that `runtime:` ids used to give. And since
// target ids are machine-generated (`ssh-<timestamp>-<random>`), the label a caller actually
// knows never matches one, so this fires on the common spelling rather than a rare typo.
// Resolving the label and naming the alternative is what makes the failure recoverable.
export async function resolveSshHostTargetId(
  client: RuntimeClient,
  targetId: string,
  environments: readonly EnvironmentSummary[]
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
      `Ambiguous SSH target in --host ssh:${targetId}: ${ambiguous.length} targets share that label. Use the target id.`,
      {
        knownSshTargets: ambiguous,
        nextSteps: ambiguous.map((target) => `Use --host ssh:${target.id} for ${target.label}.`)
      }
    )
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `Unknown SSH target in --host ssh:${targetId}: this Orca host has no SSH target named or with id ${targetId}.`,
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
