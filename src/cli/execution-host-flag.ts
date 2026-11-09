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
  fetchSshTargetSummaries,
  LOCAL_HOST_LIST_NAME,
  normalizeTypedName,
  resolveSshHostTargetId,
  sshConnectionStep,
  stripWrappingQuotes,
  type EnvironmentSummary,
  type SshTargetSummary
} from './host-selector-alternatives'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'
import { isLocalEnvironmentSelector } from './local-environment-selector'

export type HostFlagRoutingSelection = {
  // Enumerating SSH targets needs the running host; defer lookup until error recovery.
  listSshTargets: () => Promise<SshTargetSummary[]>
  // Fail on unreadable targets: routing a bare name requires ruling out SSH collisions.
  verifySshTargets: () => Promise<SshTargetSummary[]>
  pairingCode: string | null
  // Preserve the selection source, including ORCA_ENVIRONMENT, for conflict messages.
  environmentSelector: { value: string; label: string } | null
}

// Host labels need async catalog lookup before they can resolve to a machine.
export type HostFlagAlias = { kind: 'alias'; alias: string }
export type HostFlagSelection = ParsedExecutionHost | HostFlagAlias

function isLocalHostListName(alias: string): boolean {
  return normalizeTypedName(alias) === LOCAL_HOST_LIST_NAME
}

export function parseHostFlag(flags: Map<string, string | boolean>): HostFlagSelection | undefined {
  if (!flags.has('host')) {
    return undefined
  }
  const raw = flags.get('host')
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --host')
  }
  const value = stripWrappingQuotes(raw.trim())
  const parsed = parseExecutionHostId(value)
  if (parsed) {
    return parsed
  }
  const alias = value.trim()
  // Prefixed values must parse as IDs, never aliases; malformed IDs could rebind downstream.
  if (!alias || alias.startsWith('ssh:') || alias.startsWith('runtime:')) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid --host value: ${raw}. To run on another server, use --server <id>; \`orca server list\` prints each id.`
    )
  }
  return { kind: 'alias', alias }
}

// Pairing IDs are local to this computer; route to the saved server before applying its filters.
export async function resolveHostFlagEnvironmentId(
  flags: Map<string, string | boolean>,
  selection: HostFlagRoutingSelection
): Promise<string | null> {
  const host = parseHostFlag(flags)
  if (host?.kind !== 'runtime' && host?.kind !== 'alias') {
    return null
  }
  const [{ resolveEnvironment }, { getDefaultUserDataPath }, { listEnvironments }] =
    await Promise.all([
      import('./runtime/environments.js'),
      import('./runtime-client.js'),
      import('../shared/remote-runtime/host-store/runtime-environment-store.js')
    ])
  const userDataPath = getDefaultUserDataPath()
  const environments = listEnvironments(userDataPath).map((candidate) => ({
    id: candidate.id,
    name: candidate.name
  }))
  const wanted = host.kind === 'runtime' ? host.environmentId : host.alias
  const flagSpelling = host.kind === 'runtime' ? `--host ${host.id}` : `--host ${host.alias}`
  // An explicit server selection scopes bare aliases to that server's local/SSH hosts.
  if (host.kind === 'alias' && (selection.environmentSelector || selection.pairingCode)) {
    return null
  }
  // Accept server names but canonicalize them to IDs for stored-host comparisons.
  const environment = findEnvironmentByName(environments, wanted)
  if (!environment) {
    assertEnvironmentNameUnambiguous(environments, wanted, flagSpelling)
    // A missing server alias may still name this computer or one of its SSH targets.
    if (host.kind === 'alias') {
      return null
    }
    const sshTargets = await selection.listSshTargets()
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown server in ${flagSpelling}: no saved server has that id or name.`,
      {
        knownServers: environments,
        knownSshTargets: sshTargets,
        nextSteps: [
          ...crossKindNextSteps(wanted, { environments, sshTargets }, 'server'),
          'Run `orca server list` to see saved servers.',
          'Use --server local for the Orca on this computer.'
        ]
      }
    )
  }
  if (host.kind === 'alias') {
    if (isLocalHostListName(host.alias)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Ambiguous --host ${host.alias}: it names both this computer and a saved server.`,
        {
          knownServers: [environment],
          nextSteps: [
            'Use --server local for the Orca on this computer.',
            `Use --server ${environment.id} for the saved server named ${environment.name}.`
          ]
        }
      )
    }
    await assertAliasNamesOneHost(host.alias, environment, selection)
  }
  if (selection.pairingCode) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${flagSpelling} already selects a saved server; use either --server <id> or --pairing-code, not both.`
    )
  }
  if (selection.environmentSelector) {
    const { value } = selection.environmentSelector
    const selected = isLocalEnvironmentSelector(value)
      ? null
      : (findEnvironmentByName(environments, value) ?? resolveEnvironment(userDataPath, value))
    if (selected?.id !== environment.id) {
      throw new RuntimeClientError(
        'invalid_argument',
        `${flagSpelling} and ${selection.environmentSelector.label} ${selection.environmentSelector.value} name different servers; pass only --server.`
      )
    }
  }
  return environment.id
}

// An alias naming both a saved server and an SSH target must not choose either silently.
async function assertAliasNamesOneHost(
  alias: string,
  environment: EnvironmentSummary,
  selection: HostFlagRoutingSelection
): Promise<void> {
  let sshTargets: SshTargetSummary[]
  try {
    sshTargets = await selection.verifySshTargets()
  } catch {
    throw new RuntimeClientError(
      'invalid_argument',
      `Cannot verify --host ${alias}: it names a saved server, but this computer's SSH connections could not be read to rule out one with the same name.`,
      {
        knownServers: [environment],
        nextSteps: [
          `Use --server ${environment.id} for the saved server named ${environment.name}.`
        ]
      }
    )
  }
  // Duplicate SSH labels are ambiguous, not evidence that no target matches.
  const matched = findSshTargetByName(sshTargets, alias)
  const conflicts = matched ? [matched] : ambiguousSshTargets(sshTargets, alias)
  if (conflicts.length === 0) {
    return
  }
  const sshCount =
    conflicts.length === 1 ? 'an SSH target' : `${conflicts.length} SSH targets sharing that label`
  throw new RuntimeClientError(
    'invalid_argument',
    `Ambiguous --host ${alias}: it names both a saved server and ${sshCount} on this computer.`,
    {
      knownServers: [environment],
      knownSshTargets: conflicts,
      nextSteps: [
        `Use --server ${environment.id} for the saved server named ${environment.name}.`,
        sshConnectionStep(alias)
      ]
    }
  )
}

// After routing, local and runtime:<id> setups both belong to the selected server.
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

// Validate SSH IDs against the connected server, not this computer's pairing store.
export async function resolveHostFlagTarget(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<ParsedExecutionHost | undefined> {
  const host = parseHostFlag(flags)
  if (host?.kind !== 'ssh' && host?.kind !== 'alias') {
    return host
  }
  const [, { getDefaultUserDataPath }, { listEnvironments }] = await Promise.all([
    import('./runtime/environments.js'),
    import('./runtime-client.js'),
    import('../shared/remote-runtime/host-store/runtime-environment-store.js')
  ])
  const environments = listEnvironments(getDefaultUserDataPath()).map((candidate) => ({
    id: candidate.id,
    name: candidate.name
  }))
  if (host.kind === 'alias' && isLocalHostListName(host.alias)) {
    return resolveLocalHostListName(host.alias, client)
  }
  // Server lookup already missed; SSH is the remaining alias scope.
  const wanted = host.kind === 'ssh' ? host.targetId : host.alias
  const flagSpelling = host.kind === 'ssh' ? `--host ${host.id}` : `--host ${host.alias}`
  const targetId = await resolveSshHostTargetId(
    client,
    wanted,
    environments,
    flagSpelling,
    host.kind === 'alias'
  )
  const sshHostId = toSshExecutionHostId(targetId)
  return parseExecutionHostId(sshHostId) ?? { kind: 'ssh', id: sshHostId, targetId }
}

async function resolveLocalHostListName(
  alias: string,
  client: RuntimeClient
): Promise<ParsedExecutionHost> {
  // Strict listing: an unreadable target list cannot rule out a clash.
  const { targets: sshTargets } = await fetchSshTargetSummaries<SshTargetSummary>(client)
  const clashing = sshTargets.filter(
    (target) => normalizeTypedName(target.label) === LOCAL_HOST_LIST_NAME
  )
  if (clashing.length > 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Ambiguous --host ${alias}: it names both this computer and an SSH connection.`,
      {
        knownSshTargets: clashing,
        nextSteps: ['Use --server local for the Orca on this computer.', sshConnectionStep(alias)]
      }
    )
  }
  return { kind: 'local', id: LOCAL_EXECUTION_HOST_ID }
}

// Preserve the store's refusal to guess between duplicate server names.
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
    `Ambiguous server in ${flag}: ${ambiguous.length} saved servers are named ${name}. Use the server id.`,
    {
      knownServers: ambiguous,
      nextSteps: ambiguous.map(
        (candidate) => `Use --server ${candidate.id} for the server named ${candidate.name}.`
      )
    }
  )
}

// Resolve here so cross-host suggestions survive store errors that discard structured data.
export async function resolveEnvironmentSelectorForStore(
  selector: string,
  listSshTargetsForSuggestion: () => Promise<SshTargetSummary[]>
): Promise<string> {
  const [, { getDefaultUserDataPath }, { listEnvironments }] = await Promise.all([
    import('./runtime/environments.js'),
    import('./runtime-client.js'),
    import('../shared/remote-runtime/host-store/runtime-environment-store.js')
  ])
  const environments = listEnvironments(getDefaultUserDataPath()).map((candidate) => ({
    id: candidate.id,
    name: candidate.name
  }))
  const found = findEnvironmentByName(environments, selector)
  if (found) {
    return found.id === selector || found.name === selector ? selector : found.id
  }
  assertEnvironmentNameUnambiguous(environments, selector, `--server ${selector}`)
  const sshTargets = await listSshTargetsForSuggestion()
  throw new RuntimeClientError(
    'invalid_argument',
    `Unknown server in --server ${selector}: no saved server has that id or name.`,
    {
      knownServers: environments,
      knownSshTargets: sshTargets,
      nextSteps: [
        ...crossKindNextSteps(selector, { environments, sshTargets }, 'server'),
        'Run `orca server list` to see saved servers, or use --server local for the Orca on this computer.'
      ]
    }
  )
}
