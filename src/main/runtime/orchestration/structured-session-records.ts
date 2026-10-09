import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredWorkerHostScope } from '../structured-worker-identity'

export type AgentSessionRecordReader = {
  getRecord: (sessionId: string) => AgentSessionRecord | null
  listRecords: () => AgentSessionRecord[]
  /** Absent on a store that predates tab visibility; every session then counts as open. */
  getVisibleSessionTabIndex?: () => { present: boolean; sessionIds: string[] }
}

/** Reading never installs the host or starts a provider. */
export function readAgentSessionRecordStore(): AgentSessionRecordReader | null {
  return getStructuredAgentSessionHost()?.deps.store ?? null
}

export function readStructuredAgentSessionRecord(
  store: AgentSessionRecordReader | null,
  sessionId: string
): AgentSessionRecord | null {
  try {
    return store?.getRecord(sessionId) ?? null
  } catch {
    return null
  }
}

export type StructuredSessionRecord = {
  readonly sessionId: string
  readonly record: AgentSessionRecord
}

/** Host location is separate from process liveness; unreadability never proves exit. */
export type LocatedStructuredSessionRecord =
  | ({ kind: 'here' } & StructuredSessionRecord)
  | ({ kind: 'other-host' } & StructuredSessionRecord)
  | { kind: 'unverifiable'; reason: string }

export function locateStructuredSessionRecord(
  store: AgentSessionRecordReader | null,
  sessionId: string
): LocatedStructuredSessionRecord {
  if (!store) {
    return {
      kind: 'unverifiable',
      reason: 'The structured agent-session host is not installed in this runtime generation.'
    }
  }
  const record = readStructuredAgentSessionRecord(store, sessionId)
  if (!record) {
    return {
      kind: 'unverifiable',
      reason: `No durable record backs structured session ${sessionId}.`
    }
  }
  const located = { sessionId, record }
  return structuredWorkerHostScope(record.location)
    ? { kind: 'here', ...located }
    : { kind: 'other-host', ...located }
}
