import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import {
  ORCA_SESSION_ADDRESS_PREFIX,
  parseOrcaSessionAddress,
  type OrcaSessionId
} from '../../../shared/orca-session-address'
import type { OrchestrationDb } from './db'
import { DISPATCH_CONTEXT_COLUMN_LIST } from './db/row-column-lists'
import type { DispatchContextRow } from './types'
import { structuredSessionMailReach } from './structured-session-mail-address'
import {
  lineageLiveSession,
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from './structured-session-lineage'

/** The chat a Dispatch assignee handle names; null for a terminal or a structured worker. */
export function chatAssigneeSessionId(
  assigneeHandle: string | null | undefined
): OrcaSessionId | null {
  return assigneeHandle ? parseOrcaSessionAddress(assigneeHandle) : null
}

export type ChatAssigneeObservation =
  /** `session` is the conversation's live session: its `/clear` successor, if it has one. */
  | { status: 'live'; session: AgentSessionConversationView }
  | { status: 'exited'; reason: string }
  | { status: 'unverifiable'; reason: string }

/** Idle chats remain live; only closed chats exited, while missing or remote records are unverifiable. */
export function observeChatAssignee(
  sessionId: OrcaSessionId,
  db: OrchestrationDb | null | undefined,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): ChatAssigneeObservation {
  if (!store) {
    return {
      status: 'unverifiable',
      reason: 'The agent-session host is not installed in this runtime generation.'
    }
  }
  const record = store.getRecord(sessionId)
  if (!record) {
    return { status: 'unverifiable', reason: 'No durable record backs this chat.' }
  }
  const reach = structuredSessionMailReach(store, record, db)
  switch (reach.kind) {
    case 'reachable':
      return { status: 'live', session: reach.session }
    case 'other-host':
      return { status: 'unverifiable', reason: 'The chat runs on another host.' }
    case 'unverifiable':
      return {
        status: 'unverifiable',
        reason: `The session continuing this chat after a /clear cannot be verified: ${reach.reason}`
      }
    case 'ended':
      switch (reach.reason) {
        case 'closed':
          return { status: 'exited', reason: 'The chat was closed.' }
        case 'worker-identity-lost':
          // Chats currently have no worker incarnation; unexpected observation still cannot prove exit.
          return {
            status: 'unverifiable',
            reason:
              'The session that continues this chat is a worker whose identity this host lost.'
          }
      }
  }
}

/** Select unsettled Dispatches only for this hidden session after its exit is proven; other closes may roll back. */
export function exitedChatDispatchesForSession(
  hiddenSessionId: string,
  db: OrchestrationDb,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): (DispatchContextRow & { assignee_handle: string })[] {
  if (!store) {
    return []
  }
  const rows = db.db
    .prepare(
      `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
        WHERE status IN ('pending', 'dispatched') AND substr(assignee_handle, 1, ?) = ?`
    )
    .all(ORCA_SESSION_ADDRESS_PREFIX.length, ORCA_SESSION_ADDRESS_PREFIX)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The schema-pinned complete Dispatch projection returns Dispatch rows; the adapter exposes unknown.
  return (rows as DispatchContextRow[]).filter(
    (dispatch): dispatch is DispatchContextRow & { assignee_handle: string } => {
      const chat = chatAssigneeSessionId(dispatch.assignee_handle)
      return (
        chat !== null &&
        lineageLiveSession(store, chat)?.sessionId === hiddenSessionId &&
        observeChatAssignee(chat, db, store).status === 'exited'
      )
    }
  )
}
