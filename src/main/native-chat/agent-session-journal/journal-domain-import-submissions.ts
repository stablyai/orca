import { readAnsweredTurn } from './projection/journal-dispatch-reducer'
import type Database from '../../sqlite/sync-database'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { stoppedHistoryCandidate } from '../../../shared/agent-session/lifecycle/agent-session-stopped-history'
import type { JournalReducerState } from './projection/journal-reducer'
import {
  journalDomainSubmissionFactsJson,
  type JournalDomainSubmissionAttempt
} from './journal-domain-submission-records'
import {
  journalInputSourceBody,
  journalInputSourceFamily,
  journalInputSourceScope,
  journalInputSourceSequence
} from './input-order/journal-input-source'

export type JournalDomainImportAttempt = JournalDomainSubmissionAttempt & { echoObserved: boolean }

/** Interpret frozen source facts only during the one-way import. */
export function restoredJournalDomainSubmission(
  state: JournalReducerState,
  submission: AgentJournalSubmission,
  ordinal: number,
  admittedPersonal: boolean
): JournalDomainImportAttempt {
  const id = submission.clientMessageId
  const source = state.inputs.sources.get(id)
  const request = source?.kind === 'submission' ? source : source?.submission
  const handover = state.inputs.handovers.get(id)
  const place = state.queuedHandOffPlaces.get(id)
  const rejected = state.inputs.rejections.get(id)
  const rejectedEvent = rejected && 'kind' in rejected ? rejected : undefined
  const rejectedSend = rejected && !('kind' in rejected) ? rejected : undefined
  return {
    submission,
    sequence: journalInputSourceSequence(source) ?? submission.submittedSequence ?? 0,
    index: source?.kind === 'outcome-admission' ? (source.item.sequenceIndex ?? 0) : 0,
    ordinal,
    candidate: state.inputs.candidates.has(id),
    admittedPersonal,
    echoObserved: state.inputs.echoes.has(agentJournalSubmissionKey(id)),
    admission: {
      body:
        submission.dispatchState === 'pending' ||
        submission.dispatchState === 'unknown' ||
        stoppedHistoryCandidate(submission)
          ? journalInputSourceBody(source)
          : null,
      providerHandle: source?.kind === 'submission' ? source.providerHandle : null,
      fence: source?.fence ?? submission.fence,
      scope: journalInputSourceScope(source) ?? null,
      familyId: journalInputSourceFamily(source) ?? submission.queuedMessageId ?? null,
      origin: request?.origin ?? null,
      sourceKind: request?.source?.kind ?? null,
      options: request?.options ?? null
    },
    handover: handover
      ? {
          sequence: handover.seq,
          at: handover.ts,
          fence: handover.fence,
          scope: handover.turnScope ?? null
        }
      : null,
    handoverPlace: place
      ? {
          sequence: place.sequence,
          at: place.observedAt,
          scope: place.turnScope
        }
      : null,
    carries: state.stoppedHistoryCarried.get(id) ?? [],
    rejection: rejected
      ? {
          sequence: rejectedEvent?.seq ?? rejectedSend?.submittedSequence ?? 0,
          at: rejectedEvent?.ts ?? rejectedSend?.resolvedAt ?? rejectedSend?.submittedAt ?? 0,
          fence: rejected.fence,
          reason: rejected.reason,
          fact: rejected.rejection ?? null,
          recovered: rejected.recovered === true,
          keptMessageId: rejected.keptAsQueuedMessageId ?? null,
          ...(rejected.answeredInTurn === undefined
            ? {}
            : { answeredInTurn: readAnsweredTurn(rejected.answeredInTurn) })
        }
      : null,
    presentationMember: state.inputs.presentations.has(id),
    normalizedHandOff: state.normalizedHandOffs.has(id)
  }
}

/** One named current-attempt insert, idempotent while the chat is still unready. */
export function insertJournalDomainImportedSubmission(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  attempt: JournalDomainImportAttempt
): void {
  const { submission, admission, handover } = attempt
  db.prepare(`INSERT INTO journal_submission_attempts(session_id,epoch,message_id,
    attempt_sequence,attempt_index,current,item_id,ordinal,submitted_at,accepted_sequence,
    fingerprint,dispatch_state,candidate,admitted_personal,dispatch_fence,signed_out,recovered,payload_json,echo_observed,
    admission_body_json,admission_family_id,handover_fence,facts_json)
    VALUES(?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).run(
    target.sessionId,
    target.epoch,
    submission.clientMessageId,
    attempt.sequence,
    attempt.index,
    agentJournalSubmissionKey(submission.clientMessageId),
    attempt.ordinal,
    submission.submittedAt,
    submission.acceptedSequence ?? null,
    submission.payloadFingerprint,
    submission.dispatchState,
    Number(attempt.candidate),
    Number(attempt.admittedPersonal),
    submission.fence,
    Number(
      submission.dispatchState === 'rejected' &&
        readWholeAgentSessionFailureFact(submission.rejection)?.kind === 'notSignedIn'
    ),
    Number(submission.recovered === true),
    JSON.stringify(submission),
    Number(attempt.echoObserved),
    admission.body === null ? null : JSON.stringify(admission.body),
    admission.familyId,
    handover?.fence ?? null,
    journalDomainSubmissionFactsJson(attempt)
  )
}
