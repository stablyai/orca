/** Validators for the review / linked-ticket corner of a dashboard card. */

import {
  isBoundedString,
  isFiniteNumber,
  isOptionalWebUrl,
  MAX_LABEL_LENGTH
} from './dashboard-payload-primitives'

const DASHBOARD_REVIEW_STATES = new Set(['open', 'closed', 'merged', 'draft'])
const DASHBOARD_CHECK_STATUSES = new Set(['pending', 'success', 'failure', 'neutral'])

export function isDashboardReview(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const review = value as Record<string, unknown>
  return (
    isFiniteNumber(review.number) &&
    review.number > 0 &&
    typeof review.state === 'string' &&
    DASHBOARD_REVIEW_STATES.has(review.state) &&
    (review.checksStatus === undefined ||
      (typeof review.checksStatus === 'string' &&
        DASHBOARD_CHECK_STATUSES.has(review.checksStatus))) &&
    isOptionalWebUrl(review.url)
  )
}

export function isDashboardLinearIssue(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const issue = value as Record<string, unknown>
  return isBoundedString(issue.identifier, MAX_LABEL_LENGTH) && isOptionalWebUrl(issue.url)
}
