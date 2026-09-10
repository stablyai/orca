import type {
  MaestroHumanReview,
  MaestroHumanReviewCreateRequest,
  MaestroHumanReviewTransitionRequest
} from '../../../../../shared/maestro-human-review'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import { getMaestroHumanReview } from './maestro-human-review-persistence'

export function requireMaestroHumanReviewTaskDispatch(
  database: OrchestrationDb,
  request: MaestroHumanReviewCreateRequest,
  now: Date
): void {
  const task = database.getTask(request.task_id)
  const dispatch = database.getDispatchContextById(request.dispatch_id)
  if (
    !task ||
    !dispatch ||
    task.run_id !== request.workspace.run_id ||
    dispatch.run_id !== request.workspace.run_id ||
    dispatch.task_id !== task.id
  ) {
    throw new OrchestrationError(
      'request_mismatch',
      'Human review requires the exact Task and Dispatch in this Run.'
    )
  }
  const browser = request.references.browser
  if (!browser) {
    return
  }
  const surface = database.getMaestroBrowserSurface(browser.surface_id)?.receipt
  if (
    !surface ||
    surface.run_id !== request.workspace.run_id ||
    surface.task_id !== request.task_id ||
    surface.attempt_id !== request.dispatch_id ||
    surface.execution_host_id !== request.workspace.execution_host_id ||
    surface.workspace_key !== request.workspace.workspace_key ||
    surface.browser_page_id !== browser.browser_page_id ||
    surface.state === 'released'
  ) {
    throw new OrchestrationError(
      'request_mismatch',
      'Human review requires the exact Browser surface and returned page for its Dispatch.'
    )
  }
  if (surface.profile_id !== null) {
    requireActiveProfileConsent(database, request, surface.profile_id, now)
  }
}

export function requireExactMaestroHumanReview(
  database: OrchestrationDb,
  request: MaestroHumanReviewTransitionRequest
): MaestroHumanReview {
  const review = getMaestroHumanReview(database, request.review_id)
  if (
    !review ||
    review.workspace.run_id !== request.workspace.run_id ||
    review.workspace.execution_host_id !== request.workspace.execution_host_id ||
    review.workspace.workspace_key !== request.workspace.workspace_key
  ) {
    throw new OrchestrationError('review_not_found', 'Human review was not found in this Run.')
  }
  return review
}

export function sameMaestroHumanReviewCreateRequest(
  review: MaestroHumanReview,
  request: MaestroHumanReviewCreateRequest
): boolean {
  return (
    review.review_id === request.review_id &&
    review.task_id === request.task_id &&
    review.dispatch_id === request.dispatch_id &&
    review.title === request.title &&
    review.summary === request.summary &&
    review.staged_receipt.state === request.state &&
    JSON.stringify(review.workspace) === JSON.stringify(request.workspace) &&
    JSON.stringify(review.references) === JSON.stringify(request.references) &&
    JSON.stringify(review.decisions) === JSON.stringify(request.decisions)
  )
}

function requireActiveProfileConsent(
  database: OrchestrationDb,
  request: MaestroHumanReviewCreateRequest,
  profileId: string,
  now: Date
): void {
  const consent = request.references.browser?.profile_consent_receipt
  const issued = consent
    ? database.getMaestroBrowserProfileConsent(consent, request.workspace)
    : null
  if (
    !consent ||
    consent.profile_id !== profileId ||
    consent.run_id !== request.workspace.run_id ||
    consent.task_id !== request.task_id ||
    consent.attempt_id !== request.dispatch_id ||
    !issued ||
    issued.revoked_at !== null ||
    Date.parse(issued.expires_at) <= now.getTime()
  ) {
    throw new OrchestrationError(
      'browser_profile_consent_required',
      'Human review requires the active host-issued consent for its Browser profile.'
    )
  }
}
