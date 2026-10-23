/**
 * A structured session's `/clear` lineage, read off the durable session records. `/clear` continues
 * a chat in a new session; the committed clear on the old record names the session that replaced it.
 * Derived from the records every time; nothing is rewritten at a clear.
 */

import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredWorkerHostScope } from '../structured-worker-identity'

export type AgentSessionRecordReader = {
  getRecord: (sessionId: string) => AgentSessionConversationView | null
  listRecords: () => AgentSessionConversationView[]
  /** Absent on a store that predates tab visibility; every session then counts as open. */
  getVisibleSessionTabIndex?: () => { present: boolean; sessionIds: string[] }
}

/** Null until the agent-session host is installed; callers that must see records ensure it first. */
export function readAgentSessionRecordStore(): AgentSessionRecordReader | null {
  const store = getStructuredAgentSessionHost()?.deps.store
  return store ? conversationRecordReader(store) : null
}

export function conversationRecordReader(store: {
  getConversation: AgentSessionRecordReader['getRecord']
  listConversations: AgentSessionRecordReader['listRecords']
  getVisibleSessionTabIndex: NonNullable<AgentSessionRecordReader['getVisibleSessionTabIndex']>
}): AgentSessionRecordReader {
  return {
    getRecord: store.getConversation,
    listRecords: store.listConversations,
    getVisibleSessionTabIndex: store.getVisibleSessionTabIndex
  }
}

/** The session a committed `/clear` continued this one in, if any. */
export function clearedInto(record: AgentSessionConversationView): string | null {
  const command = record.conversationCommand
  return command?.command === 'clear' && command.phase === 'committed'
    ? (command.replacementSessionId ?? null)
    : null
}

/** The session running a lineage now, its record, and every session of the lineage up to it. */
export type RunningStructuredSession = {
  readonly sessionId: string
  readonly record: AgentSessionConversationView
  readonly lineage: readonly string[]
}

/**
 * Where the session running a `/clear` lineage is now. `lineage` lists every session walked, from
 * the one asked about to the running one. `unverifiable` is not being able to look — no record
 * store, a successor with no record, a corrupt chain — and never evidence the conversation ended.
 */
export type LineageRunningSession =
  | ({ kind: 'here' } & RunningStructuredSession)
  | ({ kind: 'other-host' } & RunningStructuredSession)
  | { kind: 'unverifiable'; reason: string; lineage: readonly string[] }

/** The one forward walk: which session runs `sessionId`'s conversation now. */
export function resolveLineageRunningSession(
  store: AgentSessionRecordReader | null,
  sessionId: string
): LineageRunningSession {
  const lineage = [sessionId]
  if (!store) {
    return {
      kind: 'unverifiable',
      reason: 'The structured agent-session host is not installed in this runtime generation.',
      lineage
    }
  }
  let current = sessionId
  for (;;) {
    let record: AgentSessionConversationView | null
    try {
      record = store.getRecord(current)
    } catch {
      record = null
    }
    if (!record) {
      // A clear writes the successor with its pointer, so a missing record is unreadable.
      return {
        kind: 'unverifiable',
        reason: `No durable record backs structured session ${current}.`,
        lineage
      }
    }
    const next = clearedInto(record)
    if (!next) {
      const running = { sessionId: current, record, lineage }
      return structuredWorkerHostScope(record.location)
        ? { kind: 'here', ...running }
        : { kind: 'other-host', ...running }
    }
    if (lineage.includes(next)) {
      return {
        kind: 'unverifiable',
        reason: `The /clear lineage of structured session ${sessionId} loops back on itself.`,
        lineage
      }
    }
    lineage.push(next)
    current = next
  }
}

/** The record running the lineage now; null when that cannot be verified. */
export function lineageLiveSession(
  store: AgentSessionRecordReader,
  sessionId: string
): AgentSessionConversationView | null {
  const running = resolveLineageRunningSession(store, sessionId)
  return running.kind === 'unverifiable' ? null : running.record
}
