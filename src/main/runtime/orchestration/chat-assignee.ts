/**
 * A chat as a Dispatch assignee. Its Dispatch row names its conversation address and holds no
 * pane or process: whether it can still work is read off the
 * session records the same way mail to it is, so the two can never disagree.
 */

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
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
  readStructuredAgentSessionRecord,
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from './structured-session-records'

/** The chat a Dispatch assignee handle names; null for a terminal or a structured worker. */
export function chatAssigneeSessionId(
  assigneeHandle: string | null | undefined
): OrcaSessionId | null {
  return assigneeHandle ? parseOrcaSessionAddress(assigneeHandle) : null
}

export type ChatAssigneeObservation =
  /** The durable conversation record. */
  | { status: 'live'; session: AgentSessionRecord }
  | { status: 'exited'; reason: string }
  | { status: 'unverifiable'; reason: string }

/**
 * A chat at rest is live: the send that reaches it starts its agent. Only a closed chat has
 * exited; a record this host lacks, or another host, is unverifiable: missing evidence is no exit.
 */
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
  const record = readStructuredAgentSessionRecord(store, sessionId)
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
        reason: `The chat cannot be verified: ${reach.reason}`
      }
    case 'ended':
      switch (reach.reason) {
        case 'closed':
          return { status: 'exited', reason: 'The chat was closed.' }
        case 'worker-identity-lost':
          // Not reachable for a chat today (its Dispatch records no worker incarnation); still no exit.
          return {
            status: 'unverifiable',
            reason: 'The chat is a worker whose identity this host lost.'
          }
      }
  }
}

/**
 * The unsettled Dispatches of the chat whose current session's tab was hidden, once that chat has
 * exited, re-derived from the records at the notice. Only that chat: another chat may be mid-close
 * with its tab hidden, and a close can still put its tab back.
 */
export function exitedChatDispatchesForSession(
  hiddenSessionId: string,
  db: OrchestrationDb,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): DispatchContextRow[] {
  const chat = parseOrcaSessionAddress(`${ORCA_SESSION_ADDRESS_PREFIX}${hiddenSessionId}`)
  if (!store || !chat || observeChatAssignee(chat, db, store).status !== 'exited') {
    return []
  }
  const rows = db.db
    .prepare(
      `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
        WHERE status IN ('pending', 'dispatched') AND assignee_handle = ?`
    )
    .all(`${ORCA_SESSION_ADDRESS_PREFIX}${chat}`)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The schema-pinned complete Dispatch projection returns Dispatch rows; the adapter exposes unknown.
  return rows as DispatchContextRow[]
}
