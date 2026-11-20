import type { CreateHostedReviewResult } from '../../shared/source-control/hosted-review/hosted-review-contracts'
import { HostedReviewApiRequestError } from '../source-control/hosted-review-api-request'

export function apiErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function classifyGiteaCreateError(error: unknown): CreateHostedReviewResult {
  const message = apiErrorMessage(error)
  if (message) {
    console.warn('createGiteaPullRequest failed:', message)
  }
  const lower = message.toLowerCase()
  const status = error instanceof HostedReviewApiRequestError ? error.status : null
  if (
    status === 401 ||
    status === 403 ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('authentication')
  ) {
    return {
      ok: false,
      code: 'auth_required',
      error:
        'Create PR failed: Gitea is not authenticated. Next step: set ORCA_GITEA_TOKEN or run gt auth login in this environment.',
      reason: 'auth_required'
    }
  }
  if (status === 409 || lower.includes('already exists') || lower.includes('already open')) {
    return {
      ok: false,
      code: 'already_exists',
      error: 'A pull request already exists for this branch.',
      reason: 'existing_review'
    }
  }
  if (
    (error instanceof HostedReviewApiRequestError && error.timedOut) ||
    lower.includes('timed out') ||
    lower.includes('timeout')
  ) {
    return {
      ok: false,
      code: 'unknown_completion',
      error: 'PR creation may have completed. Refreshing branch review state...',
      reason: 'creation_unconfirmed'
    }
  }
  if (status === 400 || status === 422 || lower.includes('validation')) {
    return {
      ok: false,
      code: 'validation',
      error:
        'Create PR failed: Gitea rejected the pull request. Check the base branch and branch state, then try again.',
      reason: 'rejected'
    }
  }
  return {
    ok: false,
    code: 'unknown',
    error: 'Create PR failed: Gitea could not create the pull request. Try again in a moment.',
    reason: 'create_failed'
  }
}

export function parseGtCreatedPull(stdout: string): { number: number; url: string } | null {
  try {
    const parsed = JSON.parse(stdout)
    if (parsed && typeof parsed === 'object') {
      const number =
        typeof parsed.number === 'number'
          ? parsed.number
          : typeof parsed.index === 'number'
            ? parsed.index
            : null
      const url =
        typeof parsed.url === 'string'
          ? parsed.url
          : typeof parsed.html_url === 'string'
            ? parsed.html_url
            : null
      if (number !== null && url) {
        return { number, url }
      }
    }
  } catch {
    return null
  }
  return null
}
