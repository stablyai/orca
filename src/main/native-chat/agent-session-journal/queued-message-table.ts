// Host-owned draft rows for messages queued while the main agent is working.
//
// A queued message is NOT a journal row: it becomes one — an ordinary
// submission — only when consume converts it, in the same transaction as the
// submission's append. Until then it lives here, `session_id`-keyed so it
// survives epoch rollover and replacement (`journal-row-table.ts` deletes only
// `journal_rows`). After a refusal its text survives as a `returned` row a
// rewind cannot delete — a command refused in its own turn is spent instead, its
// turn's row saying why; after a withdrawal it waits again.

import type Database from '../../sqlite/sync-database'
import type { UnreadAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import type {
  AgentJournalCursor,
  AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import type { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session-queued-message-wire'
import { rejectedDraftSettlement } from './journal-dispatch-settlement'
import { readStoredQueuedMessageRow } from './queued-message-stored-row'

export type QueuedMessageState = 'waiting' | 'dispatched' | 'returned' | 'withdrawn'

/** Why ONE waiting draft is held from auto-sending: its conversion failed (`send_failed`). Stored
 *  on the row, so it survives handle eviction and restart; a wire marker (it publishes as
 *  `pausedReason`). A Stop, a /clear or a reopen pauses the queue instead. A reader treats an
 *  unknown stored value as a plain hold, and the holds earlier builds wrote that this one derives
 *  (`QUEUED_MESSAGE_RETIRED_HOLD_REASONS`) as none. */
export type QueuedMessageHoldReason = typeof QUEUED_MESSAGE_PAUSED_SEND_FAILED

/** Definitively unsettled: what Stop, /clear, Edit and the published-bytes bound count, and
 *  what the published list shows. Pending/unknown/accepted deliveries and
 *  tombstones stay outside it. */
export function isUnsettledQueuedMessage(row: Pick<QueuedMessageRow, 'state'>): boolean {
  return row.state === 'waiting' || row.state === 'returned'
}

export type QueuedMessageRow = {
  sessionId: string
  messageId: string
  position: number
  body: AgentJournalMessageItem
  fingerprint: string
  createdAt: number
  hostInstance: string
  state: QueuedMessageState
  /** Non-null holds this one waiting draft from auto-sending; typed values in
   *  `QueuedMessageHoldReason`, unknown strings read as a plain hold. */
  holdReason: string | null
  /** A returned card's refusal, mirroring its submission's `reason` and `rejection` pair. */
  returnedReason: string | null
  returnedRejection: UnreadAgentSessionFailureFact | null
  settledAt: number | null
  /** The operation ledger's caller-scoped key, making settled rows mutation receipts. */
  settledByOp: string | null
  /** The submission that last handed it off: set on every dispatched row, kept on a returned
   *  card, cleared when a withdrawal sends it back to waiting. Host-only; the published link is
   *  the submission's `queuedMessageId`. */
  consumedAs: string | null
  /** Inert historical column; current inserts write null. */
  carriedFrom: string | null
  /** Where the journal stood when it was queued: a Stop's pause holds only cards queued before
   *  it. Null on rows from builds before it was recorded, which read as queued before any Stop. */
  queuedAt: AgentJournalCursor | null
}

const COLUMNS =
  'session_id, message_id, position, body_json, fingerprint, created_at, host_instance, state, hold_reason, returned_reason, returned_rejection, settled_at, settled_by_op, consumed_as, carried_from, queued_epoch, queued_sequence'

export function insertQueuedMessage(
  db: Database.Database,
  input: {
    sessionId: string
    messageId: string
    body: AgentJournalMessageItem
    fingerprint: string
    hostInstance: string
    queuedAt: AgentJournalCursor
    now: number
    /** Absent: after every other card. */
    position?: number
    holdReason?: QueuedMessageHoldReason
  }
): QueuedMessageRow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the statement selects exactly one aliased numeric column; better-sqlite3 types rows as unknown.
  const highest = db
    .prepare('SELECT COALESCE(MAX(position), 0) AS p FROM queued_messages WHERE session_id = ?')
    .get(input.sessionId) as { p?: number } | undefined
  const position = input.position ?? Number(highest?.p ?? 0) + 1
  db.prepare(
    `INSERT INTO queued_messages (${COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`
  ).run(
    input.sessionId,
    input.messageId,
    position,
    JSON.stringify(input.body),
    input.fingerprint,
    input.now,
    input.hostInstance,
    input.holdReason ?? null,
    null,
    input.queuedAt.epoch,
    input.queuedAt.sequence
  )
  return {
    sessionId: input.sessionId,
    messageId: input.messageId,
    position,
    body: input.body,
    fingerprint: input.fingerprint,
    createdAt: input.now,
    hostInstance: input.hostInstance,
    state: 'waiting',
    holdReason: input.holdReason ?? null,
    returnedReason: null,
    returnedRejection: null,
    settledAt: null,
    settledByOp: null,
    consumedAs: null,
    carriedFrom: null,
    queuedAt: input.queuedAt
  }
}

export function listQueuedMessages(db: Database.Database, sessionId: string): QueuedMessageRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM queued_messages WHERE session_id = ? ORDER BY position ASC`)
    .all(sessionId)
    .flatMap((row) => readStoredQueuedMessageRow(row) ?? [])
}

export function getQueuedMessage(
  db: Database.Database,
  sessionId: string,
  messageId: string
): QueuedMessageRow | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM queued_messages WHERE session_id = ? AND message_id = ?`)
    .get(sessionId, messageId)
  return row === undefined ? null : readStoredQueuedMessageRow(row)
}

/**
 * The one waiting→dispatched (or returned→dispatched) transition, always under
 * a fresh submission id — never the draft's own — so no reader can mistake id
 * equality for the hand-off link. MUST run inside the caller's transaction — the journal
 * writer's, between BEGIN IMMEDIATE and COMMIT — so a failed submission append
 * rolls the consume back and a failed consume rolls the append back. Returns
 * false when the draft was not in the expected state, in which case the caller
 * throws to abort the append.
 */
export function consumeQueuedMessageInTransaction(
  db: Database.Database,
  input: {
    sessionId: string
    messageId: string
    expect: 'waiting' | 'returned'
    /** The body being sent: a card edited since it was read is not consumed with its old text. */
    fingerprint: string
    /** The fresh submission id; never the draft's own id. */
    consumedAs: string
    settledByOp: string | null
    /** The handing-off process; absent keeps the row's own. */
    hostInstance?: string
    now: number
  }
): boolean {
  if (input.consumedAs === input.messageId) {
    return false
  }
  const changed = db
    .prepare(
      `UPDATE queued_messages
       SET state = 'dispatched', hold_reason = NULL, returned_reason = NULL, returned_rejection = NULL,
           settled_at = ?, settled_by_op = ?, consumed_as = ?, host_instance = COALESCE(?, host_instance)
       WHERE session_id = ? AND message_id = ? AND state = ? AND fingerprint = ?`
    )
    .run(
      input.now,
      input.settledByOp,
      input.consumedAs,
      input.hostInstance ?? null,
      input.sessionId,
      input.messageId,
      input.expect,
      input.fingerprint
    )
  return Number(changed.changes ?? 0) === 1
}

/** Compare-and-transition unsettled rows (waiting ∪ returned) to withdrawn
 *  tombstones stamped with the operation's caller-scoped key, kept only so a
 *  replay of the settling operation answers "spent"; null when the host itself
 *  withdrew it. Returns the rows actually transitioned; their text stays in
 *  this database, never on the wire. */
export function withdrawQueuedMessages(
  db: Database.Database,
  input: {
    sessionId: string
    messageIds: readonly string[]
    settledByOp: string | null
    now: number
  }
): QueuedMessageRow[] {
  const withdrawn: QueuedMessageRow[] = []
  for (const messageId of input.messageIds) {
    const row = getQueuedMessage(db, input.sessionId, messageId)
    if (!row || !isUnsettledQueuedMessage(row)) {
      continue
    }
    db.prepare(
      `UPDATE queued_messages
       SET state = 'withdrawn', hold_reason = NULL, settled_at = ?, settled_by_op = ?
       WHERE session_id = ? AND message_id = ? AND state IN ('waiting', 'returned')`
    ).run(input.now, input.settledByOp, input.sessionId, messageId)
    withdrawn.push({
      ...row,
      state: 'withdrawn',
      holdReason: null,
      settledAt: input.now,
      settledByOp: input.settledByOp
    })
  }
  return withdrawn
}

/**
 * dispatched → returned, or back to waiting (`rejectedDraftSettlement`),
 * matched on the draft's CURRENT hand-off (`consumed_as`), so a re-send refused
 * again still settles while a late duplicate of an earlier refusal matches
 * nothing. A withdrawal keeps its position; a command refused in its own turn is spent.
 */
export function settleRejectedQueuedMessage(
  db: Database.Database,
  input: {
    sessionId: string
    consumedRef: string
    reason: string | null
    rejection: UnreadAgentSessionFailureFact | undefined
    /** The refused submission's command turn exists, so its own row says why. */
    commandTurnReported: boolean
    now: number
  }
): boolean {
  const settlement = rejectedDraftSettlement(input)
  if (
    settlement.state === 'returned' &&
    input.commandTurnReported &&
    spendRefusedCommandCard(db, input)
  ) {
    return true
  }
  const changed =
    settlement.state === 'waiting'
      ? db
          .prepare(
            `UPDATE queued_messages
             SET state = 'waiting', hold_reason = NULL, consumed_as = NULL,
                 returned_reason = NULL, returned_rejection = NULL, settled_at = NULL, settled_by_op = NULL
             WHERE session_id = ? AND state = 'dispatched' AND consumed_as = ?`
          )
          .run(input.sessionId, input.consumedRef)
      : db
          .prepare(
            `UPDATE queued_messages
             SET state = 'returned', returned_reason = ?, returned_rejection = ?, settled_at = ?
             WHERE session_id = ? AND state = 'dispatched' AND consumed_as = ?`
          )
          .run(
            input.reason,
            input.rejection ? JSON.stringify(input.rejection) : null,
            input.now,
            input.sessionId,
            input.consumedRef
          )
  return Number(changed.changes ?? 0) > 0
}

/**
 * A command card refused in its own turn is spent, not returned: that turn's row says why, once,
 * and a returned card would hold every card behind it. Refused before any turn (a failed start),
 * it is returned like any card; a restart or a close leaves it waiting under the queue's pause.
 * False when the dispatched card is not a command.
 */
function spendRefusedCommandCard(
  db: Database.Database,
  input: { sessionId: string; consumedRef: string; now: number }
): boolean {
  const spent = db
    .prepare(
      `UPDATE queued_messages SET state = 'withdrawn', settled_at = ?
       WHERE session_id = ? AND state = 'dispatched' AND consumed_as = ?
         AND json_extract(body_json, '$.command') IS NOT NULL`
    )
    .run(input.now, input.sessionId, input.consumedRef)
  return Number(spent.changes ?? 0) > 0
}

/** Replay receipts: every row a given caller-scoped operation settled. */
export function queuedMessagesSettledByOp(
  db: Database.Database,
  sessionId: string,
  settledByOp: string
): QueuedMessageRow[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM queued_messages
       WHERE session_id = ? AND settled_by_op = ? ORDER BY position ASC`
    )
    .all(sessionId, settledByOp)
    .flatMap((row) => readStoredQueuedMessageRow(row) ?? [])
}
