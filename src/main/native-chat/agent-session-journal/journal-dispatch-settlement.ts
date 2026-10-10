// The one decision for whether a committed dispatch row changes a submission's
// effective delivery answer, and what a rejection does to the draft it was
// consumed from. The reducer folds rows through the first and the queued
// draft's settlement hook fires through it, so the two can never disagree: a
// row the reducer ignores must not alter a draft.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { classifyDispatchRejection } from '../../../shared/structured-agent-session-dispatch-rejection'
import type { JournalDispatchRow } from './journal-row-schema'

/** `rejected` and `accepted` are terminal; a late row for an absent or settled
 *  submission must not reopen the answer. */
export function journalDispatchRowApplies(
  submission: Pick<AgentJournalSubmission, 'dispatchState'> | undefined
): boolean {
  return (
    submission !== undefined &&
    submission.dispatchState !== 'rejected' &&
    submission.dispatchState !== 'accepted'
  )
}

/** A consumed draft's submission settled `rejected`: the draft is settled by
 *  `rejectedDraftSettlement`, since its text has no other holder once it left
 *  the sender's outbox as a draft. */
export function consumedSubmissionWasRejected(
  submission: Pick<AgentJournalSubmission, 'dispatchState'> | undefined
): boolean {
  return submission?.dispatchState === 'rejected'
}

/** What a consumed draft becomes when its submission is rejected. */
export type RejectedDraftSettlement = { state: 'returned' | 'waiting' }

/**
 * A withdrawal waits at its original position under the queue's pause; a failure returns the
 * card, except a command refused in its own turn, whose row already reports it.
 */
export function rejectedDraftSettlement(
  rejected: Pick<AgentJournalSubmission, 'reason'> & { rejection?: unknown }
): RejectedDraftSettlement {
  return { state: classifyDispatchRejection(rejected).verdict !== null ? 'returned' : 'waiting' }
}

/** True when committing this row NEWLY settles the submission to `rejected` —
 *  the only transition that settles a consumed draft. */
export function journalDispatchRowNewlyRejects(
  submission: Pick<AgentJournalSubmission, 'dispatchState'> | undefined,
  row: Pick<JournalDispatchRow, 'state'>
): boolean {
  return row.state === 'rejected' && journalDispatchRowApplies(submission)
}
