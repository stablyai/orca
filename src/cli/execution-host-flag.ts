import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ParsedExecutionHost
} from '../shared/execution-host'
import { RuntimeClientError } from './runtime/types'

export type HostFlagRoutingSelection = {
  pairingCode: string | null
  environmentSelector: string | null
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
  const environment = listEnvironments(userDataPath).find(
    (candidate) => candidate.id === host.environmentId
  )
  if (!environment) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown Orca server in --host ${host.id}: no paired environment has id ${host.environmentId}. Run \`orca environment list\` to see paired servers, or pass --host local.`
    )
  }
  if (selection.pairingCode) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--host ${host.id} already selects a paired Orca server; use either --host runtime:<id> or --pairing-code, not both.`
    )
  }
  if (selection.environmentSelector) {
    const selected = resolveEnvironment(userDataPath, selection.environmentSelector)
    if (selected.id !== environment.id) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--host ${host.id} and --environment ${selection.environmentSelector} name different Orca servers.`
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
