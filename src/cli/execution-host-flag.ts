import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ParsedExecutionHost
} from '../shared/execution-host'
import {
  crossKindNextSteps,
  findEnvironmentByName,
  resolveSshHostTargetId,
  type SshTargetSummary
} from './host-selector-alternatives'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'

export type HostFlagRoutingSelection = {
  // Why: SSH targets live in the running Orca host, not on disk, so enumerating them needs a
  // client. Injected as a thunk so the lookup only happens on the error path we are explaining.
  listSshTargets: () => Promise<SshTargetSummary[]>
  pairingCode: string | null
  // Why: an ambient ORCA_ENVIRONMENT counts as a selection too, so carry the label to
  // name the real source in the conflict message.
  environmentSelector: { value: string; label: string } | null
}

export function parseHostFlag(
  flags: Map<string, string | boolean>
): ParsedExecutionHost | undefined {
  if (!flags.has('host')) {
    return undefined
  }
  const raw = flags.get('host')
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --host')
  }
  const parsed = parseExecutionHostId(raw)
  if (!parsed) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid --host value: ${raw}. Expected local, ssh:<target-id>, or runtime:<environment-id>.`
    )
  }
  return parsed
}

// Why: `runtime:<environment-id>` ids are minted by this machine's pairing store, so they
// only name a machine relative to it. Filtering or mutating the locally connected runtime
// with one answers for the wrong host, and an id that matches nothing is indistinguishable
// from a real host with no rows — so resolve the id here and send the command to it.
export async function resolveHostFlagEnvironmentId(
  flags: Map<string, string | boolean>,
  selection: HostFlagRoutingSelection
): Promise<string | null> {
  const host = parseHostFlag(flags)
  if (host?.kind !== 'runtime') {
    return null
  }
  const [{ listEnvironments, resolveEnvironment }, { getDefaultUserDataPath }] = await Promise.all([
    import('./runtime/environments.js'),
    import('./runtime-client.js')
  ])
  const userDataPath = getDefaultUserDataPath()
  const known = listEnvironments(userDataPath)
  // Why: --environment has always taken a name or an id, and the name is what people and agents
  // actually know. Requiring the raw uuid here made the obvious spelling fail; accept either and
  // canonicalize to the id so stored host ids still compare correctly downstream.
  const environment = findEnvironmentByName(
    known.map((candidate) => ({ id: candidate.id, name: candidate.name })),
    host.environmentId
  )
  if (!environment) {
    // Why: `runtime:<id>` is a host id that also appears in stored rows, so it resolves by id
    // only — unlike --environment, which also accepts a name. Say so, and hand back the ids an
    // agent can retry with instead of making it scrape the sentence.
    const environments = known.map((candidate) => ({ id: candidate.id, name: candidate.name }))
    const sshTargets = await selection.listSshTargets()
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown Orca server in --host ${host.id}: no paired Orca server is named or has id ${host.environmentId}.`,
      {
        knownEnvironments: environments,
        knownSshTargets: sshTargets,
        nextSteps: [
          ...crossKindNextSteps(host.environmentId, { environments, sshTargets }, 'environment'),
          'Run `orca environment list` to see paired Orca servers.',
          'Use --host local to target this machine.'
        ]
      }
    )
  }
  if (selection.pairingCode) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--host ${host.id} already selects a paired Orca server; use either --host runtime:<id> or --pairing-code, not both.`
    )
  }
  if (selection.environmentSelector) {
    const selected = resolveEnvironment(userDataPath, selection.environmentSelector.value)
    if (selected.id !== environment.id) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--host ${host.id} and ${selection.environmentSelector.label} ${selection.environmentSelector.value} name different Orca servers.`
      )
    }
  }
  return environment.id
}

// Why: a runtime stamps its own setups `local` when they were made on the box and
// `runtime:<id>` when a paired client made them. Once --host routed the command to that
// runtime both spellings mean the same machine, so a host filter has to accept both.
export function hostFilterMatchesHostId(
  filter: ParsedExecutionHost,
  candidateHostId: string | null | undefined
): boolean {
  const candidate = normalizeExecutionHostId(candidateHostId)
  if (candidate === filter.id) {
    return true
  }
  return filter.kind === 'runtime' && candidate === LOCAL_EXECUTION_HOST_ID
}

// Why: `ssh:` reaches a machine the connected runtime owns, so it can only be checked against
// that runtime — unlike `runtime:`, which is resolved from this machine's pairing store before a
// client exists. Callers that act on a --host value run this so an unknown target fails loudly
// instead of quietly filtering to nothing.
export async function resolveHostFlagTarget(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<ParsedExecutionHost | undefined> {
  const host = parseHostFlag(flags)
  if (host?.kind !== 'ssh') {
    return host
  }
  const [{ listEnvironments }, { getDefaultUserDataPath }] = await Promise.all([
    import('./runtime/environments.js'),
    import('./runtime-client.js')
  ])
  const environments = listEnvironments(getDefaultUserDataPath()).map((candidate) => ({
    id: candidate.id,
    name: candidate.name
  }))
  const targetId = await resolveSshHostTargetId(client, host.targetId, environments)
  return parseExecutionHostId(toSshExecutionHostId(targetId)) ?? host
}
