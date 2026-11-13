import { isWslUncPath } from '../../../shared/wsl-paths'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import { sameProviderKey, type AgentProviderKey } from './agent-provider-key'
import { agentProviderKeyOf } from './pane-agent-identities'

type SleepingAgentSighting = Pick<
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

/** The saved sleeping record naming `key`'s conversation, found through its provider session id
 *  and its full key. On Windows a distro-less WSL record of the same provider conversation also
 *  reads as native, so a native key never takes one with a guest path. */
export function sleepingRecordOfKey(
  records: Readonly<Record<string, SleepingAgentSighting>>,
  key: AgentProviderKey,
  windows: boolean
): SleepingAgentSighting | null {
  for (const [paneKey, record] of sleepingByProviderSession(records).get(key.providerSessionId) ??
    []) {
    if (
      records[paneKey] !== record ||
      (windows && isGuestTranscriptPath(record.providerSession.transcriptPath))
    ) {
      continue
    }
    const recordKey = agentProviderKeyOf({
      agent: record.agent,
      providerSession: record.providerSession,
      connectionId: record.connectionId ?? null
    })
    if (recordKey && sameProviderKey(recordKey, key)) {
      return record
    }
  }
  return null
}
