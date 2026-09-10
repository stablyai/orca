import type { MaestroActor } from '../../../../../shared/maestro-contract'
import {
  MaestroHumanReviewSchema,
  type MaestroHumanReview,
  type MaestroHumanReviewTransitionRequest
} from '../../../../../shared/maestro-human-review'
import { OrchestrationError } from '../../orchestration-error'

type AuthenticatedUserActor = MaestroActor & { kind: 'user'; authenticated: true }

export function transitionMaestroHumanReviewState(
  review: MaestroHumanReview,
  request: MaestroHumanReviewTransitionRequest,
  actor: AuthenticatedUserActor,
  now: Date
): MaestroHumanReview {
  const recordedAt = now.toISOString()
  if (request.action === 'approve') {
    if (!['staged', 'needs_input'].includes(review.state)) {
      throw invalidTransition(review, 'approved')
    }
    requireExactDecisionResolutions(review, request.decision_resolutions)
    if (Date.parse(request.expires_at) <= now.getTime()) {
      throw new OrchestrationError('request_mismatch', 'Review approval must expire in the future.')
    }
    return MaestroHumanReviewSchema.parse({
      ...review,
      state: 'approved_for_submit',
      unresolved_decisions: [],
      approval_receipt: {
        receipt_id: request.receipt_id,
        request_id: request.request_id,
        actor,
        decision_resolutions: request.decision_resolutions,
        expires_at: request.expires_at,
        recorded_at: recordedAt
      },
      updated_at: recordedAt
    })
  }
  if (request.action === 'submit') {
    if (review.state !== 'approved_for_submit') {
      throw invalidTransition(review, 'submitted')
    }
    return MaestroHumanReviewSchema.parse({
      ...review,
      state: 'submitted',
      submission_receipt: {
        receipt_id: request.receipt_id,
        request_id: request.request_id,
        actor,
        submission_reference: request.submission_reference,
        recorded_at: recordedAt
      },
      updated_at: recordedAt
    })
  }
  if (!['staged', 'needs_input', 'approved_for_submit'].includes(review.state)) {
    throw invalidTransition(review, 'rejected')
  }
  return MaestroHumanReviewSchema.parse({
    ...review,
    state: 'rejected',
    rejection_receipt: {
      receipt_id: request.receipt_id,
      request_id: request.request_id,
      actor,
      reason: request.reason,
      recorded_at: recordedAt
    },
    updated_at: recordedAt
  })
}

export function replayMaestroHumanReviewTransition(
  review: MaestroHumanReview,
  request: MaestroHumanReviewTransitionRequest,
  actor: AuthenticatedUserActor
): MaestroHumanReview | null {
  const recorded = [
    { action: 'approve' as const, receipt: review.approval_receipt },
    { action: 'submit' as const, receipt: review.submission_receipt },
    { action: 'reject' as const, receipt: review.rejection_receipt }
  ].find((entry) => entry.receipt?.request_id === request.request_id)
  if (!recorded?.receipt) {
    return null
  }
  const actorMatches =
    recorded.receipt.actor.actor_id === actor.actor_id &&
    recorded.receipt.actor.session_id === actor.session_id
  const payloadMatches =
    recorded.action === request.action &&
    recorded.receipt.receipt_id === request.receipt_id &&
    (request.action === 'approve'
      ? review.approval_receipt?.expires_at === request.expires_at &&
        JSON.stringify(review.approval_receipt.decision_resolutions) ===
          JSON.stringify(request.decision_resolutions)
      : request.action === 'submit'
        ? review.submission_receipt?.submission_reference === request.submission_reference
        : review.rejection_receipt?.reason === request.reason)
  if (!actorMatches || !payloadMatches) {
    throw new OrchestrationError(
      'request_mismatch',
      'The human-review transition request identity was reused with different input.'
    )
  }
  return review
}

export function expireMaestroHumanReview(
  review: MaestroHumanReview,
  now: Date
): MaestroHumanReview {
  if (
    review.state !== 'approved_for_submit' ||
    !review.approval_receipt ||
    Date.parse(review.approval_receipt.expires_at) > now.getTime()
  ) {
    return review
  }
  const recordedAt = now.toISOString()
  return MaestroHumanReviewSchema.parse({
    ...review,
    state: 'expired',
    expiration_receipt: {
      receipt_id: `expired-${review.review_id}`,
      expired_at: review.approval_receipt.expires_at,
      recorded_at: recordedAt
    },
    updated_at: recordedAt
  })
}

function requireExactDecisionResolutions(
  review: MaestroHumanReview,
  resolutions: readonly { decision_id: string; resolution: string }[]
): void {
  const expected = new Set(review.decisions.map((decision) => decision.decision_id))
  const actual = new Set(resolutions.map((resolution) => resolution.decision_id))
  if (actual.size !== resolutions.length || actual.size !== expected.size) {
    throw new OrchestrationError('request_mismatch', 'Approval must resolve every decision once.')
  }
  for (const decisionId of expected) {
    if (!actual.has(decisionId)) {
      throw new OrchestrationError('request_mismatch', 'Approval must resolve every decision once.')
    }
  }
}

function invalidTransition(review: MaestroHumanReview, target: string): OrchestrationError {
  return new OrchestrationError(
    'request_mismatch',
    `Human review ${review.review_id} cannot become ${target} from ${review.state}.`
  )
}
