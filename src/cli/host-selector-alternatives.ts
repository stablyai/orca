import type { RuntimeClient } from './runtime-client'

export type SshTargetSummary = { id: string; label: string }
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
  const wanted = name.trim().toLowerCase()
  return (
    targets.find((target) => target.id === name) ??
    targets.find((target) => target.label.trim().toLowerCase() === wanted)
  )
}

export function findEnvironmentByName(
  environments: readonly EnvironmentSummary[],
  name: string
): EnvironmentSummary | undefined {
  const wanted = name.trim().toLowerCase()
  return (
    environments.find((environment) => environment.id === name) ??
    environments.find((environment) => environment.name.trim().toLowerCase() === wanted)
  )
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
export async function listSshTargets(client: RuntimeClient): Promise<SshTargetSummary[]> {
  try {
    const result = await client.call<{ targets: SshTargetSummary[] }>('ssh.listTargetSummaries')
    return result.result.targets
  } catch {
    return []
  }
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
