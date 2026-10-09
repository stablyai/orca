// Body-free reads of the existing queue rows, never cached across a transaction.

import type Database from '../../sqlite/sync-database'
import type { SqliteBindings } from '../../sqlite/sqlite-statement'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { readStoredQueuedMessageHeader } from './queued-message-stored-row'
import type { QueuedMessageHeader } from './queued-message-table'
import {
  READABLE_QUEUED_MESSAGE,
  READABLE_UNSETTLED_QUEUED_MESSAGE
} from './queued-message-readability'

const HEADER_COLUMNS =
  'session_id, message_id, position, fingerprint, created_at, host_instance, state, hold_reason, returned_reason, settled_at, settled_by_op, consumed_as, carried_from, queued_epoch, queued_sequence'

export type QueuedMessageHeaderSelection = 'all' | 'unsettled' | 'waiting'

const SELECTIONS = {
  all: READABLE_QUEUED_MESSAGE,
  unsettled: READABLE_UNSETTLED_QUEUED_MESSAGE,
  waiting: `${READABLE_UNSETTLED_QUEUED_MESSAGE} AND state = 'waiting'`
} as const

export function* queuedMessageHeaders(
  db: Database.Database,
  sessionId: string,
  selection: QueuedMessageHeaderSelection = 'all'
): IterableIterator<QueuedMessageHeader> {
  // Close each walk before reusing its cached statement; for-of also closes on early return.
  for (const row of db
    .prepare(
      `SELECT ${HEADER_COLUMNS} FROM queued_messages
       WHERE session_id = ? AND ${SELECTIONS[selection]} ORDER BY position ASC`
    )
    .iterate(sessionId)) {
    const header = readStoredQueuedMessageHeader(row)
    if (header) {
      yield header
    }
  }
}

export function hasWaitingQueuedMessage(db: Database.Database, sessionId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM queued_messages
         WHERE session_id = ? AND ${SELECTIONS.waiting} ORDER BY position ASC LIMIT 1`
      )
      .get(sessionId) !== undefined
  )
}

export function hasReadableQueuedMessage(db: Database.Database, sessionId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM queued_messages WHERE session_id = ? AND ${READABLE_QUEUED_MESSAGE}
         ORDER BY position ASC LIMIT 1`
      )
      .get(sessionId) !== undefined
  )
}

export function dispatchedQueuedMessageHeader(
  db: Database.Database,
  sessionId: string,
  consumedAs: string
): QueuedMessageHeader | null {
  const row = db
    .prepare(
      `SELECT ${HEADER_COLUMNS} FROM queued_messages
       WHERE session_id = ? AND consumed_as = ? AND consumed_as IS NOT NULL
         AND state = 'dispatched' AND ${READABLE_QUEUED_MESSAGE}`
    )
    .get(sessionId, consumedAs)
  return row ? readStoredQueuedMessageHeader(row) : null
}

export function getQueuedMessageHeader(
  db: Database.Database,
  sessionId: string,
  messageId: string
): QueuedMessageHeader | null {
  const row = db
    .prepare(
      `SELECT ${HEADER_COLUMNS} FROM queued_messages
       WHERE session_id = ? AND message_id = ? AND ${READABLE_QUEUED_MESSAGE}`
    )
    .get(sessionId, messageId)
  return row ? readStoredQueuedMessageHeader(row) : null
}

export function queuedMessageAwaitingReopen(
  db: Database.Database,
  sessionId: string,
  submissions: ReadonlyMap<string, AgentJournalSubmission>
): boolean {
  if (hasWaitingQueuedMessage(db, sessionId)) {
    return true
  }
  for (const submission of submissions.values()) {
    if (
      submission.queuedMessageId !== undefined &&
      (submission.dispatchState === 'pending' || submission.dispatchState === 'unknown') &&
      dispatchedQueuedMessageHeader(db, sessionId, submission.clientMessageId)
    ) {
      return true
    }
  }
  return false
}

/** Only dispatched rows old enough for retention need the submission verdict. */
export function* expiredDispatchedQueuedMessageHeaders(
  db: Database.Database,
  sessionId: string,
  cutoff: number
): IterableIterator<QueuedMessageHeader> {
  let settledAt: number | null = null
  let messageId: string | null = null
  // Release each reader before deletion changes the index it traversed.
  for (;;) {
    const bindings: SqliteBindings = [sessionId, cutoff]
    if (settledAt !== null && messageId !== null) {
      bindings.push(settledAt, messageId)
    }
    const row = db
      .prepare(
        `SELECT ${HEADER_COLUMNS} FROM queued_messages
         WHERE session_id = ? AND state = 'dispatched' AND settled_at < ?
           AND ${READABLE_QUEUED_MESSAGE}
           ${settledAt === null ? '' : 'AND (settled_at, message_id) > (?, ?)'}
         ORDER BY settled_at, message_id LIMIT 1`
      )
      .get(...bindings)
    if (!row) {
      return
    }
    const header = readStoredQueuedMessageHeader(row)
    if (!header || header.settledAt === null) {
      return
    }
    settledAt = header.settledAt
    messageId = header.messageId
    yield header
  }
}

/** Inserts store JSON.stringify(body), so BLOB length is the existing UTF-8 admission measure. */
export function unsettledQueuedMessageBodyBytes(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(length(CAST(body_json AS BLOB))), 0) AS bytes FROM queued_messages
       WHERE session_id = ? AND ${READABLE_UNSETTLED_QUEUED_MESSAGE}`
    )
    .get(sessionId)
  return typeof row?.bytes === 'number' ? row.bytes : 0
}
