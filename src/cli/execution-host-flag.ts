import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ParsedExecutionHost
} from '../shared/execution-host'
import {
  ambiguousEnvironments,
  ambiguousSshTargets,
  crossKindNextSteps,
  findEnvironmentByName,
  findSshTargetByName,
  resolveSshHostTargetId,
  type EnvironmentSummary,
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

// Why: `orca host list` prints the alias a caller actually knows (`trader-local`), so that is what
// they type — but which machine it names needs the host listings, which only the async resolvers
// below can read. Carry the alias unresolved rather than rejecting the obvious spelling.
export type HostFlagAlias = { kind: 'alias'; alias: string }
export type HostFlagSelection = ParsedExecutionHost | HostFlagAlias

export function parseHostFlag(flags: Map<string, string | boolean>): HostFlagSelection | undefined {
  if (!flags.has('host')) {
    return undefined
  }
  const raw = flags.get('host')
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --host')
  }
  const parsed = parseExecutionHostId(raw)
  if (parsed) {
    return parsed
  }
  const alias = raw.trim()
  // A value that claims a kind but does not parse is malformed, not an alias: `ssh:` names no
  // target, and a `|` would rebind the id downstream. Only an unprefixed name can be a label.
  if (!alias || alias.startsWith('ssh:') || alias.startsWith('runtime:')) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid --host value: ${raw}. Expected local, ssh:<target-id>, runtime:<environment-id>, or a host name from \`orca host list\`.`
    )
  }
  return { kind: 'alias', alias }
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
  if (host?.kind !== 'runtime' && host?.kind !== 'alias') {
    return null
  }
  const [{ listEnvironments, resolveEnvironment }, { getDefaultUserDataPath }] = await Promise.all([
    import('./runtime/environments.js'),
    import('./runtime-client.js')
  ])
  const userDataPath = getDefaultUserDataPath()
  const environments = listEnvironments(userDataPath).map((candidate) => ({
    id: candidate.id,
    name: candidate.name
  }))
  const wanted = host.kind === 'runtime' ? host.environmentId : host.alias
  const flagSpelling = host.kind === 'runtime' ? `--host ${host.id}` : `--host ${host.alias}`
  // Why: --environment has always taken a name or an id, and the name is what people and agents
  // actually know. Requiring the raw uuid here made the obvious spelling fail; accept either and
  // canonicalize to the id so stored host ids still compare correctly downstream.
  const environment = findEnvironmentByName(environments, wanted)
  if (!environment) {
    assertEnvironmentNameUnambiguous(environments, wanted, flagSpelling)
    // A bare alias has a second axis left to try: SSH targets live on the connected runtime, so
    // resolveHostFlagTarget answers for them once a client exists. Missing here is not a failure.
    if (host.kind === 'alias') {
      return null
    }
    // Why: `runtime:<id>` is a host id that also appears in stored rows, so it resolves by id
    // only — unlike --environment, which also accepts a name. Say so, and hand back the ids an
    // agent can retry with instead of making it scrape the sentence.
    const sshTargets = await selection.listSshTargets()
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown Orca server in ${flagSpelling}: no paired Orca server is named or has id ${wanted}.`,
      {
        knownEnvironments: environments,
        knownSshTargets: sshTargets,
        nextSteps: [
          ...crossKindNextSteps(wanted, { environments, sshTargets }, 'environment'),
          'Run `orca environment list` to see paired Orca servers.',
          'Use --host local to target this machine.'
        ]
      }
    )
  }
  if (host.kind === 'alias') {
    await assertAliasNamesOneHost(host.alias, environment, selection)
  }
  if (selection.pairingCode) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${flagSpelling} already selects a paired Orca server; use either --host runtime:<id> or --pairing-code, not both.`
    )
  }
  if (selection.environmentSelector) {
    const selected = resolveEnvironment(userDataPath, selection.environmentSelector.value)
    if (selected.id !== environment.id) {
      throw new RuntimeClientError(
        'invalid_argument',
        `${flagSpelling} and ${selection.environmentSelector.label} ${selection.environmentSelector.value} name different Orca servers.`
      )
    }
  }
  return environment.id
}

// Why: a paired server and an SSH target are different machines, and one alias can name both.
// Picking either would send the command to a machine the caller did not choose — the failure the
// prefixed spellings exist to prevent — so hand back both flags and let them say which.
async function assertAliasNamesOneHost(
  alias: string,
  environment: EnvironmentSummary,
  selection: HostFlagRoutingSelection
): Promise<void> {
  const sshTargets = await selection.listSshTargets()
  // Why: findSshTargetByName collapses a duplicated label to undefined, which reads here as "no
  // SSH target by that name" — so two colliding targets would have looked like no conflict at all
  // and resolved to the server. Duplicates are more ambiguity, not less.
  const matched = findSshTargetByName(sshTargets, alias)
  const conflicts = matched ? [matched] : ambiguousSshTargets(sshTargets, alias)
  if (conflicts.length === 0) {
    return
  }
  const sshCount =
    conflicts.length === 1 ? 'an SSH target' : `${conflicts.length} SSH targets sharing that label`
  throw new RuntimeClientError(
    'invalid_argument',
    `Ambiguous --host ${alias}: it names both a paired Orca server and ${sshCount} on this machine.`,
    {
      knownEnvironments: [environment],
      knownSshTargets: conflicts,
      nextSteps: [
        `Use --host runtime:${environment.id} for the paired Orca server named ${environment.name}.`,
        ...conflicts.map(
          (target) => `Use --host ssh:${target.id} for the SSH target labeled ${target.label}.`
        )
      ]
    }
  )
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
  if (host?.kind !== 'ssh' && host?.kind !== 'alias') {
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
  // A bare alias reaches here only after resolveHostFlagEnvironmentId found no paired server by
  // that name, so SSH is the one axis left and an unknown name is a real failure.
  const wanted = host.kind === 'ssh' ? host.targetId : host.alias
  const flagSpelling = host.kind === 'ssh' ? `--host ${host.id}` : `--host ${host.alias}`
  const targetId = await resolveSshHostTargetId(client, wanted, environments, flagSpelling)
  const sshHostId = toSshExecutionHostId(targetId)
  return parseExecutionHostId(sshHostId) ?? { kind: 'ssh', id: sshHostId, targetId }
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
