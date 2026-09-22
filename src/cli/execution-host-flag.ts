import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ParsedExecutionHost
} from '../shared/execution-host'
import {
  ambiguousEnvironments,
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
    assertEnvironmentNameUnambiguous(environments, host.environmentId, `--host ${host.id}`)
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

// Why: the store refuses an ambiguous environment name rather than guessing which server was
// meant. Resolving one here would put the guess back, in the flag whose whole purpose is to stop
// a command reaching a machine the caller did not choose.
function assertEnvironmentNameUnambiguous(
  environments: readonly { id: string; name: string }[],
  name: string,
  flag: string
): void {
  const ambiguous = ambiguousEnvironments(environments, name)
  if (ambiguous.length === 0) {
    return
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `Ambiguous Orca server in ${flag}: ${ambiguous.length} paired servers are named ${name}. Use the environment id.`,
    {
      knownEnvironments: ambiguous,
      nextSteps: ambiguous.map(
        (candidate) => `Use --host runtime:${candidate.id} for the server named ${candidate.name}.`
      )
    }
  )
}

// Why: the inverse of the --host case. `--environment openclaw` failed with a bare "Unknown
// environment", when openclaw is very often an SSH target — a different axis, not a typo. The
// store's own error cannot carry the hint (translateStoreError forwards code and message only,
// dropping data), so resolve the selector here where the payload survives.
export async function assertEnvironmentSelectorResolvable(
  selector: string,
  listSshTargetsForSuggestion: () => Promise<SshTargetSummary[]>
): Promise<void> {
  const [{ listEnvironments }, { getDefaultUserDataPath }] = await Promise.all([
    import('./runtime/environments.js'),
    import('./runtime-client.js')
  ])
  const environments = listEnvironments(getDefaultUserDataPath()).map((candidate) => ({
    id: candidate.id,
    name: candidate.name
  }))
  if (findEnvironmentByName(environments, selector)) {
    return
  }
  assertEnvironmentNameUnambiguous(environments, selector, `--environment ${selector}`)
  const sshTargets = await listSshTargetsForSuggestion()
  throw new RuntimeClientError(
    'invalid_argument',
    `Unknown Orca server in --environment ${selector}: no paired Orca server is named or has id ${selector}.`,
    {
      knownEnvironments: environments,
      knownSshTargets: sshTargets,
      nextSteps: [
        ...crossKindNextSteps(selector, { environments, sshTargets }, 'environment'),
        'Run `orca host list` to see every machine you can target and the flag for each.'
      ]
    }
  )
}
