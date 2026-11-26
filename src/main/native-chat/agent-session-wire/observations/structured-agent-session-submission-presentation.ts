import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED,
  DISPATCH_DOUBT_WRITE_OUTCOME_UNKNOWN
} from '../../agent-session-journal/projection/journal-dispatch-doubt-reasons'

/** Admission releases presentation only; the journal still awaits an exact receipt. */
export function admittedStructuredSubmission(
  submission: AgentJournalSubmission,
  generationEnded: boolean
): AgentJournalSubmission {
  return {
    ...submission,
    dispatchState: 'unknown',
    recovered: true,
    reason:
      submission.reason ??
      (generationEnded
        ? DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED
        : DISPATCH_DOUBT_WRITE_OUTCOME_UNKNOWN)
  }
}
