import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalDomainOutlineSubmission } from './journal-domain-outline-source'
import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { classifyDispatchRejection } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import {
  refusedBeforeWrite,
  stoppedHistoryCandidate
} from '../../../shared/agent-session/lifecycle/agent-session-stopped-history'

export const JOURNAL_DOMAIN_SUBMISSION_COLUMNS = [
  'submitted_at',
  'accepted_sequence',
  'fingerprint',
  'dispatch_state',
  'dispatch_fence',
  'signed_out',
  'recovered',
  'submitted_sequence',
  'request_failure',
  'steer_turn_item_id',
  'stopped_history',
  'covers_stopped_history',
  'outline_json'
] as const

/** All current-attempt selectors describe the same saved dispatch and its source coverage. */
export function journalDomainSubmissionColumns(
  submission: AgentJournalSubmission,
  carries: readonly string[]
) {
  return [
    submission.submittedAt,
    submission.acceptedSequence ?? null,
    submission.payloadFingerprint,
    submission.dispatchState,
    submission.fence,
    Number(
      submission.dispatchState === 'rejected' &&
        readWholeAgentSessionFailureFact(submission.rejection)?.kind === 'notSignedIn'
    ),
    Number(submission.recovered === true),
    submission.submittedSequence ?? null,
    Number(
      submission.dispatchState === 'rejected' &&
        classifyDispatchRejection(submission).verdict === 'failure'
    ),
    submission.answeredInTurn?.via === 'steer' ? submission.answeredInTurn.turnItemId : null,
    Number(stoppedHistoryCandidate(submission)),
    Number(carries.length > 0 && !refusedBeforeWrite(submission)),
    journalDomainOutlineSubmission(submission)
  ]
}
