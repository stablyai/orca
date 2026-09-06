import {
  MOBILE_WEB_PROVIDER_REVIEW_CHECK_LIMIT,
  MOBILE_WEB_PROVIDER_REVIEW_USER_LIMIT,
  type MobileWebProviderReview
} from '../../../src/shared/mobile-web/provider-review-contract'

export function sanitizeMobileWebProviderReviewUsers(
  value: unknown
): MobileWebProviderReview['reviewRequests'] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .flatMap((entry) => {
      if (!isRecord(entry)) {
        return []
      }
      const login = nonemptyBoundedString(entry.login, 80)
      return login ? [{ login, name: nonemptyBoundedString(entry.name, 160) ?? null }] : []
    })
    .slice(0, MOBILE_WEB_PROVIDER_REVIEW_USER_LIMIT)
}

export function sanitizeMobileWebProviderReviewSummaries(
  value: unknown
): MobileWebProviderReview['latestReviews'] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .flatMap((entry) => {
      if (!isRecord(entry)) {
        return []
      }
      const author = isRecord(entry.author) ? entry.author : null
      const login =
        nonemptyBoundedString(entry.login, 80) ??
        (author ? nonemptyBoundedString(author.login, 80) : undefined)
      return login ? [{ login, state: nonemptyBoundedString(entry.state, 80) ?? null }] : []
    })
    .slice(0, MOBILE_WEB_PROVIDER_REVIEW_USER_LIMIT)
}

export function sanitizeMobileWebProviderReviewChecks(
  value: unknown
): MobileWebProviderReview['checks'] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .flatMap((entry) => {
      if (!isRecord(entry)) {
        return []
      }
      const name = nonemptyBoundedString(entry.name, 256)
      const status: MobileWebProviderReview['checks'][number]['status'] | null =
        entry.status === 'queued' || entry.status === 'in_progress' || entry.status === 'completed'
          ? entry.status
          : null
      const conclusion = checkConclusion(entry.conclusion)
      if (!name || !status) {
        return []
      }
      const checkRunId = positiveInteger(entry.checkRunId)
      const workflowRunId = positiveInteger(entry.workflowRunId)
      return [
        {
          name,
          status,
          conclusion,
          ...(checkRunId === null ? {} : { checkRunId }),
          ...(workflowRunId === null ? {} : { workflowRunId })
        }
      ]
    })
    .slice(0, MOBILE_WEB_PROVIDER_REVIEW_CHECK_LIMIT)
}

function checkConclusion(value: unknown): MobileWebProviderReview['checks'][number]['conclusion'] {
  return value === 'success' ||
    value === 'failure' ||
    value === 'cancelled' ||
    value === 'timed_out' ||
    value === 'neutral' ||
    value === 'skipped' ||
    value === 'pending' ||
    value === 'action_required'
    ? value
    : null
}

function nonemptyBoundedString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : undefined
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
