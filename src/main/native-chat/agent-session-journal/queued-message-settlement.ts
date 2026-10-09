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
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/structured-agent-session-command-turn-identity'
import type { JournalRow } from './journal-row-schema'
import {
  draftDeliveredByEcho,
  draftsDeliveredByAppliedEcho,
  type QueuedMessageEchoDraftReader
} from './queued-message-delivered-echo'
import {
  settleRejectedQueuedMessage,
  withdrawQueuedMessageInTransaction
} from './queued-message-table'
import { dispatchedQueuedMessageHeader, getQueuedMessageHeader } from './queued-message-headers'

type Submissions = ReadonlyMap<string, AgentJournalSubmission>

/** Some dispatched draft still waits on a settlement the journal already decided. */
export function queuedMessageSettlementOwed(
  db: Database.Database,
  sessionId: string,
  submissions: Submissions
): boolean {
  return owedQueuedMessageSettlements(db, sessionId, submissions).next().done === false
}

function* owedQueuedMessageSettlements(
  db: Database.Database,
  sessionId: string,
  submissions: Submissions
): IterableIterator<AgentJournalSubmission> {
  for (const submission of submissions.values()) {
    if (
      submission.queuedMessageId !== undefined &&
      consumedSubmissionWasRejected(submission) &&
      dispatchedQueuedMessageHeader(db, sessionId, submission.clientMessageId)
    ) {
      yield submission
    }
  }
}

/** Applies each owed settlement, and withdraws each waiting draft an applied echo proves
 *  delivered (`draftsDeliveredByAppliedEcho`); returns how many drafts changed. */
export function settleOwedQueuedMessages(
  db: Database.Database,
  input: { sessionId: string; state: JournalReducerState; now: number }
): number {
  const { submissions } = input.state
  let settled = 0
  for (const submission of owedQueuedMessageSettlements(db, input.sessionId, submissions)) {
    const changed = settleRejectedQueuedMessage(db, {
      sessionId: input.sessionId,
      consumedRef: submission.clientMessageId,
      reason: submission.reason ?? null,
      rejection: submission.rejection,
      commandTurnReported: commandTurnReported(input.state, submission.clientMessageId),
      now: input.now
    })
    settled += changed ? 1 : 0
  }
  for (const messageId of draftsDeliveredByAppliedEcho(input.state, (messageId) =>
    getQueuedMessageHeader(db, input.sessionId, messageId)
  )) {
    settled += withdrawQueuedMessageInTransaction(db, {
      sessionId: input.sessionId,
      messageId,
      settledByOp: null,
      now: input.now
    })
  }
  return settled
}

/**
 * The live hook, before `row` applies: an echo proving a waiting draft's first
 * send was delivered withdraws it; a row that NEWLY settles a dispatched
 * draft's current submission to `rejected` settles the draft — a refusal
 * returns it, a withdrawal (a Stop, a restart) sends it back to waiting
 * (`rejectedDraftSettlement`).
 * Decided by the same function the reducer folds rows through, so a row the
 * journal's settlement rules ignore never alters a draft. Returns how many
 * drafts changed.
 */
export function settleQueuedMessagesForRow(
  db: Database.Database,
  input: {
    sessionId: string
    state: JournalReducerState
    /** Read only for an unclaimed echo, without caching a transaction's provisional state. */
    drafts: () => QueuedMessageEchoDraftReader
    row: JournalRow
    now: number
  }
): number {
  const { row } = input
  let changed = 0
  const delivered = draftDeliveredByEcho(input.state, input.drafts, row)
  if (delivered !== null) {
    // Its first send reached the agent after all; sending it again would repeat it.
    changed += withdrawQueuedMessageInTransaction(db, {
      sessionId: input.sessionId,
      messageId: delivered,
      settledByOp: null,
      now: input.now
    })
  }
  if (row.kind !== 'dispatch' || row.state !== 'rejected') {
    return changed
  }
  const submission = input.state.submissions.get(row.clientMessageId)
  if (!journalDispatchRowNewlyRejects(submission, row)) {
    return changed
  }
  const settled = settleRejectedQueuedMessage(db, {
    sessionId: input.sessionId,
    consumedRef: row.clientMessageId,
    reason: row.reason,
    rejection: row.rejection,
    commandTurnReported: commandTurnReported(input.state, row.clientMessageId),
    now: input.now
  })
  return changed + (settled ? 1 : 0)
}

/** The submission's command turn is in the journal: its own row reports the refusal. */
function commandTurnReported(state: JournalReducerState, clientMessageId: string): boolean {
  return state.items.has(
    agentJournalItemKey(structuredAgentSessionCommandTurnIdentity(clientMessageId))
  )
}
