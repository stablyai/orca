// The one decision for whether a committed dispatch row changes a submission's
// effective delivery answer, and what a rejection does to the draft it was
// consumed from. The reducer folds rows through the first and the queued
// draft's settlement hook fires through it, so the two can never disagree: a
// row the reducer ignores must not alter a draft.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { classifyDispatchRejection } from '../../../shared/structured-agent-session-dispatch-rejection'
import type { JournalDispatchRow } from './journal-row-schema'

/** `rejected` and `accepted` are terminal; a late row for an absent or settled
 *  submission must not reopen the answer. The one way back from `rejected` is the
 *  person's Retry, a `requeued` row the reducer applies before this check. */
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
export type RejectedDraftSettlement = { state: 'returned' } | { state: 'waiting' }

/**
 * Where no one failed the user — a Stop withdrew it, or a restart or close
 * interrupted it before hand-over — the draft goes back to waiting at its own
 * position, under whatever pauses the queue: the Stop's own pause, or the
 * restart's, derived from the host instance. A returned card would block the
 * drafts behind it on a failure that never happened. A failure returns the
 * card with its refusal for the user to act on.
 */
export function rejectedDraftSettlement(
  rejection: Pick<AgentJournalSubmission, 'reason'> & { rejection?: unknown }
): RejectedDraftSettlement {
  return classifyDispatchRejection(rejection).verdict === null
    ? { state: 'waiting' }
    : { state: 'returned' }
}

/** True when committing this row NEWLY settles the submission to `rejected` —
 *  the only transition that settles a consumed draft. */
export function journalDispatchRowNewlyRejects(
  submission: Pick<AgentJournalSubmission, 'dispatchState'> | undefined,
  row: Pick<JournalDispatchRow, 'state'>
): boolean {
  return row.state === 'rejected' && journalDispatchRowApplies(submission)
}
