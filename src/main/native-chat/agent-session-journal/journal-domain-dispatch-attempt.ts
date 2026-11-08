import type Database from '../../sqlite/sync-database'
import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { stoppedHistoryCandidate } from '../../../shared/agent-session/lifecycle/agent-session-stopped-history'
import type { ResolveDispatchInput } from './journal-store-contracts'
import type { JournalDomainDispatchOperation } from './journal-domain-dispatch'
import type {
  JournalDomainSubmissionAttempt,
  JournalDomainSubmissionTarget
} from './journal-domain-submission-records'
import { readStoredRejectionFact } from './projection/journal-dispatch-reducer'
import {
  boundInlineText,
  JOURNAL_DISPATCH_REASON_LIMITS
} from './item-lifecycle/journal-payload-bounds'

/** Named attempt facts are written together with their public dispatch result. */
export function writeJournalDomainDispatchAttempt(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  attempt: JournalDomainSubmissionAttempt
): void {
  const {
    submission: next,
    candidate,
    handover,
    handoverPlace,
    carries,
    rejection,
    presentationMember,
    normalizedHandOff
  } = attempt
  db.prepare(`UPDATE journal_submission_attempts SET dispatch_state=?,candidate=?,payload_json=?,dispatch_fence=?,signed_out=?,
      handover_sequence=?,handover_at=?,handover_fence=?,handover_scope_json=?,handover_place_sequence=?,handover_place_at=?,handover_place_scope_json=?,carries_json=?,
      rejection_sequence=?,rejection_at=?,rejection_fence=?,rejection_reason=?,rejection_fact_json=?,rejection_recovered=?,
      rejection_kept_message_id=?,rejection_answered_turn_json=?,presentation_member=?,normalized_handoff=?,
      admission_body_json=CASE WHEN ? THEN admission_body_json ELSE NULL END
      WHERE session_id=? AND epoch=? AND message_id=? AND current=1`).run(
    next.dispatchState,
    Number(candidate),
    JSON.stringify(next),
    next.fence,
    Number(
      next.dispatchState === 'rejected' &&
        readWholeAgentSessionFailureFact(next.rejection)?.kind === 'notSignedIn'
    ),
    handover?.sequence ?? null,
    handover?.at ?? null,
    handover?.fence ?? null,
    handover ? JSON.stringify(handover.scope) : null,
    handoverPlace?.sequence ?? null,
    handoverPlace?.at ?? null,
    handoverPlace?.scope === undefined ? null : JSON.stringify(handoverPlace.scope),
    JSON.stringify(carries),
    rejection?.sequence ?? null,
    rejection?.at ?? null,
    rejection?.fence ?? null,
    rejection?.reason ?? null,
    rejection?.fact ? JSON.stringify(rejection.fact) : null,
    rejection ? Number(rejection.recovered) : null,
    rejection?.keptMessageId ?? null,
    rejection?.answeredInTurn === undefined ? null : JSON.stringify(rejection.answeredInTurn),
    Number(presentationMember),
    Number(normalizedHandOff),
    Number(
      next.dispatchState === 'pending' ||
        next.dispatchState === 'unknown' ||
        stoppedHistoryCandidate(next)
    ),
    target.sessionId,
    target.epoch,
    next.clientMessageId
  )
}

export function latestJournalDomainFamilyAttempt(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  familyId: string | null,
  messageId: string
): boolean {
  if (familyId === null) {
    return true
  }
  const latest = db
    .prepare(`SELECT message_id FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND admission_family_id=? AND current=1
    ORDER BY attempt_sequence DESC,attempt_index DESC,ordinal DESC LIMIT 1`)
    .get(target.sessionId, target.epoch, familyId)
  return latest?.message_id === messageId
}

export function journalDomainDispatchInput(
  operation: JournalDomainDispatchOperation,
  submission: AgentJournalSubmission | undefined
): ResolveDispatchInput {
  if (operation.kind !== 'late-dispatch' || operation.input.state !== 'rejected') {
    return operation.input
  }
  const { input } = operation
  return {
    ...input,
    rejection:
      input.unrun && submission?.queuedMessageId !== undefined
        ? { ...input.rejection, neverReachedAgent: true }
        : input.rejection
  }
}

export function settledJournalDomainSubmission(
  previous: AgentJournalSubmission,
  input: ResolveDispatchInput,
  savedAt: number
): AgentJournalSubmission {
  const next: AgentJournalSubmission = {
    ...previous,
    fence: input.fence,
    dispatchState: input.state,
    providerItemId:
      input.state === 'accepted' && input.providerIdentity
        ? agentJournalItemKey(input.providerIdentity)
        : null,
    reason:
      (input.state === 'unknown' || input.state === 'rejected') && input.reason
        ? boundInlineText(input.reason, JOURNAL_DISPATCH_REASON_LIMITS).text
        : null,
    resolvedAt: input.state === 'pending' ? null : savedAt
  }
  delete next.rejection
  delete next.answeredInTurn
  delete next.recovered
  if (input.state === 'pending') {
    next.handedOverAt = savedAt
  }
  if (input.state === 'rejected') {
    const rejection = readStoredRejectionFact(input.rejection)
    if (rejection) {
      next.rejection = rejection
    }
    if (input.keptAsQueuedMessageId) {
      next.keptAsQueuedMessageId = input.keptAsQueuedMessageId
    }
    next.answeredInTurn = input.answeredInTurn
      ? {
          turnItemId: agentJournalItemKey(input.answeredInTurn.turn),
          via: input.answeredInTurn.via
        }
      : null
  }
  if (input.recovered) {
    next.recovered = true
  }
  return next
}
