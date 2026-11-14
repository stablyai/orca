import { isWslUncPath, parseWslUncPath } from '../../../shared/wsl-paths'
import { WSL_HOOK_RELAY_CONNECTION_PREFIX } from '../../../shared/wsl-hook-relay-contract'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import { sameProviderKey, type AgentProviderKey } from './agent-provider-key'
import { agentProviderKeyOf, type ProviderSessionSighting } from './pane-agent-identities'
import type { OrcaSessionId } from '../../../shared/orca-session-address'
import type { SavedKeyPopulation } from './saved-agent-key-ids'

/** A sleeping agent whose saved record can't say which WSL distro it ran in, so it can't be
 *  found by its full key until it wakes. */
export const SAVED_WITHOUT_DISTRO = 'saved-without-distro'

export type SleepingAgentSighting = Pick<
  SleepingAgentSessionRecord,
  'agent' | 'providerSession' | 'connectionId' | 'wslDistro'
>

type SleepingByProviderSession = Map<string, [paneKey: string, record: SleepingAgentSighting][]>

/** Each saved sleeping map's records by provider session id, built once per map: the store
 *  replaces a session's map when it saves one, and every hit is rechecked against the map. */
const sleepingIndexes = new WeakMap<object, SleepingByProviderSession>()

function sleepingByProviderSession(
  records: Readonly<Record<string, SleepingAgentSighting>>
): SleepingByProviderSession {
  let index = sleepingIndexes.get(records)
  if (!index) {
    index = new Map()
    for (const [paneKey, record] of Object.entries(records)) {
      const entries = index.get(record.providerSession.id) ?? []
      entries.push([paneKey, record])
      index.set(record.providerSession.id, entries)
    }
    sleepingIndexes.set(records, index)
  }
  return index
}

/** A WSL guest's transcript path; on Windows a distro-less sleeping record may carry one. */
function isGuestTranscriptPath(path: string | undefined): boolean {
  return (
    path !== undefined &&
    (isWslUncPath(path) ||
      (path.startsWith('/') && !path.startsWith('//') && !/^\/[A-Za-z]:(\/|$)/.test(path)))
  )
}

/** The WSL distro a saved record's agent ran in: the one it saved, else, for a record saved
 *  before Orca kept it, the distro its WSL UNC transcript path names. '' for a native agent;
 *  undefined when the record can't say, which on Windows is any other guest path. */
function sleepingRecordDistro(record: SleepingAgentSighting, windows: boolean): string | undefined {
  if (record.wslDistro !== undefined) {
    return record.wslDistro
  }
  const path = record.providerSession.transcriptPath
  const unc = path ? parseWslUncPath(path) : null
  if (unc) {
    return unc.distro
  }
  return windows && isGuestTranscriptPath(path) ? undefined : ''
}

/** The provider conversation a saved record names, qualified by where it ran, as its live
 *  hook row would name it; null when the record no longer says which WSL distro that was. */
export function sleepingRecordSighting(
  record: SleepingAgentSighting,
  windows: boolean
): ProviderSessionSighting | null {
  const connectionId = record.connectionId ?? null
  // A record from a foreign connection (a direct SSH relay) keeps it, and names no key here.
  if (connectionId !== null) {
    return { agent: record.agent, providerSession: record.providerSession, connectionId }
  }
  const distro = sleepingRecordDistro(record, windows)
  return distro === undefined
    ? null
    : {
        agent: record.agent,
        providerSession: record.providerSession,
        connectionId: distro ? `${WSL_HOOK_RELAY_CONNECTION_PREFIX}${distro}` : null
      }
}

/** The conversation a saved sleeping record names, by its full provider key. */
export function sleepingRecordKey(
  record: SleepingAgentSighting,
  windows: boolean
): AgentProviderKey | null {
  const sighting = sleepingRecordSighting(record, windows)
  return sighting ? agentProviderKeyOf(sighting) : null
}

/** Each of `records`' ids through `idsOfKeys`, in order; null for one naming no key. Answers
 *  are kept for every record of `saved`, the map they come from. */
export async function sleepingRecordIds(
  saved: Readonly<Record<string, SleepingAgentSighting>>,
  records: readonly SleepingAgentSighting[],
  windows: boolean,
  idsOfKeys: (
    keys: AgentProviderKey[],
    population: SavedKeyPopulation
  ) => Promise<(OrcaSessionId | null)[]>
): Promise<(OrcaSessionId | null)[]> {
  const keys = records.map((record) => sleepingRecordKey(record, windows))
  const asked = keys.filter((key): key is AgentProviderKey => key !== null)
  // Asked even for no keys, so a changed or emptied saved map reaches the memo.
  const ids = await idsOfKeys(asked, {
    source: saved,
    keys: () => Object.values(saved).flatMap((record) => sleepingRecordKey(record, windows) ?? [])
  })
  let next = 0
  return keys.map((key) => (key ? (ids[next++] ?? null) : null))
}

/** The saved sleeping record naming `key`'s conversation, found through its provider session id
 *  and its full key, distro included: native and WSL agents may share a provider session id. */
export function sleepingRecordOfKey<T extends SleepingAgentSighting>(
  records: Readonly<Record<string, T>>,
  key: AgentProviderKey,
  windows: boolean
): T | null {
  for (const [paneKey, record] of sleepingByProviderSession(records).get(key.providerSessionId) ??
    []) {
    if (records[paneKey] !== record) {
      continue
    }
    const recordKey = sleepingRecordKey(record, windows)
    if (recordKey && sameProviderKey(recordKey, key)) {
      return records[paneKey]!
    }
  }
  return null
}

/** A saved record of `key`'s provider conversation that can't name it because it doesn't say
 *  which WSL distro it ran in (saved before Orca kept one); null when there is none. */
export function sleepingRecordWithoutDistro<T extends SleepingAgentSighting>(
  records: Readonly<Record<string, T>>,
  key: AgentProviderKey,
  windows: boolean
): T | null {
  for (const [paneKey, record] of sleepingByProviderSession(records).get(key.providerSessionId) ??
    []) {
    if (
      records[paneKey] === record &&
      record.agent === key.agent &&
      (record.connectionId ?? null) === null &&
      sleepingRecordSighting(record, windows) === null
    ) {
      return records[paneKey]!
    }
  }
  return null
}

/** The saved record naming `key`, or `SAVED_WITHOUT_DISTRO` when one of its conversation exists
 *  but can't say which WSL distro it ran in; null when nothing saved names it. */
export function sleepingRecordNaming<T extends SleepingAgentSighting>(
  records: Readonly<Record<string, T>>,
  key: AgentProviderKey,
  windows: boolean
): T | typeof SAVED_WITHOUT_DISTRO | null {
  return (
    sleepingRecordOfKey(records, key, windows) ??
    (sleepingRecordWithoutDistro(records, key, windows) ? SAVED_WITHOUT_DISTRO : null)
  )
}
