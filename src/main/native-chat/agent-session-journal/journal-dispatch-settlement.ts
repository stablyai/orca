// Reducer and queue settlement must agree: ignored dispatch rows cannot change card state.

import { agentJournalSubmissionProvenUnwritten } from '../../../shared/agent-session-queued-submission'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { classifyDispatchRejection } from '../../../shared/structured-agent-session-dispatch-rejection'

/** Accepted/rejected states are terminal; late rows must never reopen them. */
export function journalDispatchRowApplies(
  submission: Pick<AgentJournalSubmission, 'dispatchState'> | undefined
): boolean {
  return (
    submission !== undefined &&
    submission.dispatchState !== 'rejected' &&
    submission.dispatchState !== 'accepted'
  )
}

/** Requeue only proven-undelivered cards; ambiguous handoffs stay spent. */
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
