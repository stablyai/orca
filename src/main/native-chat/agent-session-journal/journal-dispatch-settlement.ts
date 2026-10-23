// The one decision for whether a committed dispatch row changes a submission's
// effective delivery answer, and what a rejection does to the card it was
// handed off from. The reducer folds rows through the first and the queue's
// fold reads the answer it leaves, so the two can never disagree: a row the
// reducer ignores must not alter a card.

import { agentJournalSubmissionProvenUnwritten } from '../../../shared/agent-session-queued-submission'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { classifyDispatchRejection } from '../../../shared/structured-agent-session-dispatch-rejection'

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

/** What a refused hand-off makes of its card: a failure returns it; a message Orca proves never
 *  reached the agent waits again; anything else may have reached it, so it is never sent again. */
export type QueuedHandOffOutcome = 'returned' | 'waiting' | 'inDoubt'

export function queuedHandOffOutcome(
  rejected: Pick<
    AgentJournalSubmission,
    'reason' | 'rejection' | 'handoverRecorded' | 'handedOverAt' | 'answeredInTurn'
  >
): QueuedHandOffOutcome {
  if (classifyDispatchRejection(rejected).verdict !== null) {
    return 'returned'
  }
  return agentJournalSubmissionProvenUnwritten(rejected) ? 'waiting' : 'inDoubt'
}
