import type { MaestroActor } from '../../../../../shared/maestro-contract'
import {
  MaestroHumanReviewCreateRequestSchema,
  MaestroHumanReviewSchema,
  MaestroHumanReviewTransitionRequestSchema,
  type MaestroHumanReview,
  type MaestroHumanReviewCreateRequest,
  type MaestroHumanReviewTransitionRequest
} from '../../../../../shared/maestro-human-review'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import {
  getMaestroHumanReviewByRequestId,
  parseMaestroHumanReviewRow,
  persistMaestroHumanReview,
  readMaestroHumanReviewRows
} from './maestro-human-review-persistence'
import {
  expireMaestroHumanReview,
  replayMaestroHumanReviewTransition,
  transitionMaestroHumanReviewState
} from './maestro-human-review-state-machine'
import {
  requireExactMaestroHumanReview,
  requireMaestroHumanReviewTaskDispatch,
  sameMaestroHumanReviewCreateRequest
} from './maestro-human-review-request-validation'

export { getMaestroHumanReview } from './maestro-human-review-persistence'

export function listMaestroHumanReviews(
  database: OrchestrationDb,
  workspace: MaestroHumanReview['workspace'],
  now = new Date()
): MaestroHumanReview[] {
  expireApprovedReviews(database, workspace, now)
  return readMaestroHumanReviewRows(database, workspace).map(parseMaestroHumanReviewRow)
}

export function createMaestroHumanReview(
  database: OrchestrationDb,
  input: MaestroHumanReviewCreateRequest,
  actor: MaestroActor,
  now = new Date()
): MaestroHumanReview {
  const request = MaestroHumanReviewCreateRequestSchema.parse(input)
  const existing = getMaestroHumanReviewByRequestId(database, request.request_id)
  if (existing) {
    if (!sameMaestroHumanReviewCreateRequest(existing, request)) {
      throw new OrchestrationError(
        'request_mismatch',
        'The human-review request identity was reused with different input.'
      )
    }
    return existing
  }
  requireMaestroHumanReviewTaskDispatch(database, request, now)
  const recordedAt = now.toISOString()
  const review = MaestroHumanReviewSchema.parse({
    schema_version: 1,
    protocol: 'maestro-human-review/v1',
    review_id: request.review_id,
    workspace: request.workspace,
    coordinator_generation: request.coordinator_generation,
    task_id: request.task_id,
    dispatch_id: request.dispatch_id,
    title: request.title,
    summary: request.summary,
    state: request.state,
    references: request.references,
    decisions: request.decisions,
    unresolved_decisions: request.decisions,
    staged_receipt: {
      receipt_id: request.request_id,
      actor,
      state: request.state,
      recorded_at: recordedAt
    },
    approval_receipt: null,
    submission_receipt: null,
    rejection_receipt: null,
    expiration_receipt: null,
    created_at: recordedAt,
    updated_at: recordedAt
  })
  database.db
    .prepare(
      `INSERT INTO maestro_human_reviews (
         review_id, request_id, execution_host_id, workspace_key, run_id,
         task_id, dispatch_id, references_json, review_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      review.review_id,
      request.request_id,
      review.workspace.execution_host_id,
      review.workspace.workspace_key,
      review.workspace.run_id,
      review.task_id,
      review.dispatch_id,
      JSON.stringify(review.references),
      JSON.stringify(review),
      recordedAt,
      recordedAt
    )
  return review
}

export function transitionMaestroHumanReview(
  database: OrchestrationDb,
  input: MaestroHumanReviewTransitionRequest,
  actor: MaestroActor & { kind: 'user'; authenticated: true },
  now = new Date()
): MaestroHumanReview {
  const request = MaestroHumanReviewTransitionRequestSchema.parse(input)
  database.db.exec('SAVEPOINT maestro_human_review_transition')
  try {
    const current = requireExactMaestroHumanReview(database, request)
    const replay = replayMaestroHumanReviewTransition(current, request, actor)
    if (replay) {
      database.db.exec('RELEASE maestro_human_review_transition')
      return replay
    }
    const active = expireMaestroHumanReview(current, now)
    const next = transitionMaestroHumanReviewState(active, request, actor, now)
    persistMaestroHumanReview(database, next)
    database.db.exec('RELEASE maestro_human_review_transition')
    return next
  } catch (error) {
    database.db.exec('ROLLBACK TO maestro_human_review_transition')
    database.db.exec('RELEASE maestro_human_review_transition')
    throw error
  }
}

function expireApprovedReviews(
  database: OrchestrationDb,
  workspace: MaestroHumanReview['workspace'],
  now: Date
): void {
  const rows = readMaestroHumanReviewRows(database, workspace)
  for (const row of rows) {
    const current = parseMaestroHumanReviewRow(row)
    const expired = expireMaestroHumanReview(current, now)
    if (expired !== current) {
      persistMaestroHumanReview(database, expired)
    }
  }
}
