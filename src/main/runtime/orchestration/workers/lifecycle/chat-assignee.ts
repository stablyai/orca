import type { SessionPartyReader } from '../../addressing/session-party-reader'
import type { AgentSessionConversationView } from '../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { parseOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../shared/agent-session/identity/orca-session-address-prefix'

import type { OrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { DISPATCH_CONTEXT_COLUMN_LIST } from '../../db/row-column-lists'
import type { DispatchContextRow } from '../../db/orchestration-records'
import { structuredSessionMailReach } from '../../mailbox/routing/structured-session-mail-address'
import {
  lineageLiveSession,
  readAgentSessionRecordStore,
  resolveLineageRunningSession,
  type AgentSessionRecordReader
} from '../../addressing/session-lineage/structured-session-lineage'
import {
  observeStructuredWorker,
  resolveStructuredWorkerIdentityForSession
} from '../../terminal-authority/structured-sessions/structured-worker-authority'

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
  db: SessionPartyReader | null | undefined,
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

/** A worker whose chat closed: its mailbox handle and, for a worker Orca started, its pane. */
export type ClosedChatWorker = { handle: string; paneKey: string | null }

/** Workers whose chat is this hidden session, once its exit is proven: chat assignees with an unsettled
 *  Dispatch, and the worker Orca started in it. Other closes may roll back; a /clear successor keeps the work. */
export function closedChatWorkersForSession(
  hiddenSessionId: string,
  db: OrchestrationDb,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): ClosedChatWorker[] {
  if (!store) {
    return []
  }
  const rows = db.db
    .prepare(
      `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
        WHERE status IN ('pending', 'dispatched') AND substr(assignee_handle, 1, ?) = ?`
    )
    .all(ORCA_SESSION_ADDRESS_PREFIX.length, ORCA_SESSION_ADDRESS_PREFIX)
  const closed: ClosedChatWorker[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The schema-pinned complete Dispatch projection returns Dispatch rows; the adapter exposes unknown.
  for (const dispatch of rows as DispatchContextRow[]) {
    const handle = dispatch.assignee_handle
    const chat = chatAssigneeSessionId(handle)
    if (
      handle &&
      chat !== null &&
      lineageLiveSession(store, chat)?.sessionId === hiddenSessionId &&
      observeChatAssignee(chat, db, store).status === 'exited'
    ) {
      closed.push({ handle, paneKey: null })
    }
  }
  const worker = resolveStructuredWorkerIdentityForSession(hiddenSessionId, db)
  const dispatch = worker && db.getActiveDispatchForTerminal(worker.handle, worker.paneKey)
  const state = dispatch ? db.getWorkerDispatch(dispatch.id)?.state : undefined
  if (
    worker &&
    // A start still being decided reports its own outcome, and its teardown closes the chat.
    state !== 'starting' &&
    state !== 'start_unknown' &&
    lineageLiveSession(store, worker.sessionId)?.sessionId === hiddenSessionId &&
    observeStructuredWorker(worker, {
      resolveSession: (id) => resolveLineageRunningSession(store, id)
    }).status === 'exited'
  ) {
    closed.push({ handle: worker.handle, paneKey: worker.paneKey })
  }
  return closed
}
