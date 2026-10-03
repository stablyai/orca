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
export type RejectedDraftSettlement = { state: 'returned' } | { state: 'waiting'; kept: boolean }

/**
 * Where no one failed the user, the draft goes back to waiting at its own position, under whatever
 * pauses the queue: a Stop's, or the restart's, derived from the host instance. A Send the person
 * asked for (`origin` client) that a restart or a close cut short is kept (`kept`) until they send
 * it again, as the host keeps every message a person sent and it never handed over; the queue's
 * own hand-off is not theirs, so it waits as any queued card does: under the restart's pause after
 * a restart, and plainly queued after a close in the same process. A returned card would block the drafts
 * behind it on a failure that never happened. A failure returns the card with its refusal for the
 * user to act on.
 */
export function rejectedDraftSettlement(
  rejected: Pick<AgentJournalSubmission, 'reason' | 'origin'> & { rejection?: unknown }
): RejectedDraftSettlement {
  const { verdict, kind } = classifyDispatchRejection(rejected)
  if (verdict !== null) {
    return { state: 'returned' }
  }
  const cutShort = kind === 'hostRestarted' || kind === 'chatClosed'
  return { state: 'waiting', kept: cutShort && rejected.origin === 'client' }
}

/** True when committing this row NEWLY settles the submission to `rejected` —
 *  the only transition that settles a consumed draft. */
export function journalDispatchRowNewlyRejects(
  submission: Pick<AgentJournalSubmission, 'dispatchState'> | undefined,
  row: Pick<JournalDispatchRow, 'state'>
): boolean {
  return row.state === 'rejected' && journalDispatchRowApplies(submission)
}
