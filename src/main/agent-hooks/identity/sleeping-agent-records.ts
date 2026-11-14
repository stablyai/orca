import { isWslUncPath } from '../../../shared/wsl-paths'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import { sameProviderKey, type AgentProviderKey } from './agent-provider-key'
import { agentProviderKeyOf } from './pane-agent-identities'
import type { OrcaSessionId } from '../../../shared/orca-session-address'
import type { SavedKeyPopulation } from './saved-agent-key-ids'

export type SleepingAgentSighting = Pick<
  SleepingAgentSessionRecord,
  'agent' | 'providerSession' | 'connectionId'
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

/** The conversation a saved sleeping record names. On Windows a distro-less record with a guest
 *  path names no key: its WSL distro is unknown, and it is not a native agent's. */
export function sleepingRecordKey(
  record: SleepingAgentSighting,
  windows: boolean
): AgentProviderKey | null {
  return windows && isGuestTranscriptPath(record.providerSession.transcriptPath)
    ? null
    : agentProviderKeyOf({
        agent: record.agent,
        providerSession: record.providerSession,
        connectionId: record.connectionId ?? null
      })
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
  const ids =
    asked.length > 0
      ? await idsOfKeys(asked, {
          source: saved,
          keys: () =>
            Object.values(saved).flatMap((record) => sleepingRecordKey(record, windows) ?? [])
        })
      : []
  let next = 0
  return keys.map((key) => (key ? (ids[next++] ?? null) : null))
}

/** The saved sleeping record naming `key`'s conversation, found through its provider session id
 *  and its full key. On Windows a distro-less WSL record of the same provider conversation also
 *  reads as native, so a native key never takes one with a guest path. */
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
