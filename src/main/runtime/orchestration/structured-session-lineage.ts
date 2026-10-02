/**
 * A structured session's `/clear` lineage, read off the durable session records. `/clear` continues
 * a chat in a new session; the committed clear on the old record names the session that replaced it.
 * Derived from the records every time; nothing is rewritten at a clear.
 */

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'

export type AgentSessionRecordReader = {
  getRecord: (sessionId: string) => AgentSessionRecord | null
  listRecords: () => AgentSessionRecord[]
  /** Absent on a store that predates tab visibility; every session then counts as open. */
  getVisibleSessionTabIndex?: () => { present: boolean; sessionIds: string[] }
}

/** Null until the agent-session host is installed; callers that must see records ensure it first. */
export function readAgentSessionRecordStore(): AgentSessionRecordReader | null {
  return getStructuredAgentSessionHost()?.deps.store ?? null
}

/** The session a committed `/clear` continued this one in, if any. */
export function clearedInto(record: AgentSessionRecord): string | null {
  const command = record.conversationCommand
  return command?.command === 'clear' && command.phase === 'committed'
    ? (command.replacementSessionId ?? null)
    : null
}

/** The session running the lineage now; null when the chain names a session with no record. */
export function lineageLiveSession(
  store: AgentSessionRecordReader,
  sessionId: string
): AgentSessionRecord | null {
  let live = store.getRecord(sessionId)
  const later = new Set([sessionId])
  let next = live ? clearedInto(live) : null
  while (live && next && !later.has(next)) {
    later.add(next)
    live = store.getRecord(next)
    next = live ? clearedInto(live) : null
  }
  return live
}
