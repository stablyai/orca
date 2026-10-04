// What a journal row does to the drafts, and the re-derivation behind it. The
// live hook runs inside each append's transaction; it is bookkeeping and may be
// skipped, so a dispatched draft whose current submission the journal already
// rejected is owed the settlement it would have applied, which the open-time
// repair and the drain both apply.

import type Database from '../../sqlite/sync-database'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import {
  consumedSubmissionWasRejected,
  journalDispatchRowNewlyRejects
} from './journal-dispatch-settlement'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import { draftDeliveredByEcho, draftsDeliveredByAppliedEcho } from './queued-message-delivered-echo'
import {
  listQueuedMessages,
  settleRejectedQueuedMessage,
  withdrawQueuedMessages,
  type QueuedMessageRow
} from './queued-message-table'

type Submissions = ReadonlyMap<string, AgentJournalSubmission>

/** Some dispatched draft still waits on a settlement the journal already decided. */
export function queuedMessageSettlementOwed(
  rows: readonly QueuedMessageRow[],
  submissions: Submissions
): boolean {
  return rows.some(
    (row) =>
      row.state === 'dispatched' &&
      row.consumedAs !== null &&
      consumedSubmissionWasRejected(submissions.get(row.consumedAs))
  )
}

/** Applies each owed settlement, and withdraws each waiting draft an applied echo proves
 *  delivered (`draftsDeliveredByAppliedEcho`); returns how many drafts changed. */
export function settleOwedQueuedMessages(
  db: Database.Database,
  input: { sessionId: string; state: JournalReducerState; now: number }
): number {
  const { submissions } = input.state
  let settled = 0
  for (const row of listQueuedMessages(db, input.sessionId)) {
    const consumedRef = row.consumedAs
    const submission = consumedRef === null ? undefined : submissions.get(consumedRef)
    if (
      row.state !== 'dispatched' ||
      consumedRef === null ||
      !consumedSubmissionWasRejected(submission)
    ) {
      continue
    }
    const changed = settleRejectedQueuedMessage(db, {
      sessionId: input.sessionId,
      consumedRef,
      reason: submission?.reason ?? null,
      rejection: submission?.rejection,
      now: input.now
    })
    settled += changed ? 1 : 0
  }
  const delivered = draftsDeliveredByAppliedEcho(
    input.state,
    listQueuedMessages(db, input.sessionId)
  )
  if (delivered.length > 0) {
    settled += withdrawQueuedMessages(db, {
      sessionId: input.sessionId,
      messageIds: delivered,
      settledByOp: null,
      now: input.now
    }).length
  }
  return settled
}

/**
 * The live hook, before `row` applies: an echo proving a waiting draft's first
 * send was delivered withdraws it; a row that NEWLY settles a dispatched
 * draft's current submission to `rejected` settles the draft — a refusal
 * returns it, a withdrawal (a Stop, a restart) sends it back to waiting.
 * Decided by the same function the reducer folds rows through, so a row the
 * journal's settlement rules ignore never alters a draft. Returns how many
 * drafts changed.
 */
export function settleQueuedMessagesForRow(
  db: Database.Database,
  input: {
    sessionId: string
    state: JournalReducerState
    /** Read only once the row holds an unclaimed echo: a list read inside the append's
     *  transaction must not be cached under state a rollback could undo. */
    drafts: () => readonly QueuedMessageRow[]
    row: JournalRow
    now: number
  }
): number {
  const { row } = input
  let changed = 0
  const delivered = draftDeliveredByEcho(input.state, input.drafts, row)
  if (delivered !== null) {
    // Its first send reached the agent after all; sending it again would repeat it.
    changed += withdrawQueuedMessages(db, {
      sessionId: input.sessionId,
      messageIds: [delivered],
      settledByOp: null,
      now: input.now
    }).length
  }
  if (row.kind !== 'dispatch' || row.state !== 'rejected') {
    return changed
  }
  if (!journalDispatchRowNewlyRejects(input.state.submissions.get(row.clientMessageId), row)) {
    return changed
  }
  const settled = settleRejectedQueuedMessage(db, {
    sessionId: input.sessionId,
    consumedRef: row.clientMessageId,
    reason: row.reason,
    rejection: row.rejection,
    now: input.now
  })
  return changed + (settled ? 1 : 0)
}
