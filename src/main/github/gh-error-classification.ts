import type { ClassifiedError } from '../../shared/classified-error'
import { classifiedCodeHostError as classified } from '../../shared/code-host-failure-copy'

export function classifyGhError(stderr: string): ClassifiedError {
  const s = stderr.toLowerCase()
  const trimmed = stderr.trim()
  // Rate limits also carry HTTP 403; classify them before permission failures.
  if (s.includes('rate limit')) {
    return classified('rate_limited', 'github.rateLimited')
  }
  if (s.includes('http 403') || s.includes('resource not accessible')) {
    return classified('permission_denied', 'github.issuePermissionDenied')
  }
  if (s.includes('http 404') || s.includes('could not resolve to a repository')) {
    return classified('not_found', 'issueNotFound')
  }
  if (s.includes('has disabled issues')) {
    return classified('issues_disabled', 'github.issuesDisabled')
  }
  if (s.includes('http 422') || s.includes('validation failed')) {
    return classified('validation_error', 'invalidUpdate', trimmed)
  }
  if (
    s.includes('timeout') ||
    s.includes('no such host') ||
    s.includes('network') ||
    s.includes('could not resolve host')
  ) {
    return classified('network_error', 'networkError')
  }
  return classified('unknown', 'issueUpdateFailed', trimmed)
}

// Shared classification uses mutation copy; list banners need read-specific wording.
export function classifyListIssuesError(stderr: string): ClassifiedError {
  const c = classifyGhError(stderr)
  const trimmed = stderr.trim()
  const readMessages: Record<ClassifiedError['type'], string> = {
    permission_denied:
      "You don't have permission to read issues for this repository. Check your GitHub token scopes.",
    not_found: 'Repository not found.',
    issues_disabled: 'Issues are disabled on this repository.',
    validation_error: `Invalid request — ${trimmed}`,
    rate_limited: 'GitHub rate limit hit. Try again in a few minutes.',
    network_error: 'Network error — check your connection.',
    unknown: `Failed to load issues: ${trimmed}`
  }
  return { type: c.type, message: readMessages[c.type] }
}

export type PullRequestUpdateAction =
  | 'github.pullRequestUpdateFailed'
  | 'github.autoMergeEnableFailed'
  | 'github.autoMergeDisableFailed'
  | 'github.mergeQueueAddFailed'

// Preserve classification while using PR-specific wording; `action` names the operation for unknown failures.
export function classifyPullRequestUpdateError(
  stderr: string,
  action: PullRequestUpdateAction = 'github.pullRequestUpdateFailed'
): ClassifiedError {
  const c = classifyGhError(stderr)
  const trimmed = stderr.trim()
  switch (c.type) {
    case 'permission_denied':
      return classified(c.type, 'github.pullRequestPermissionDenied')
    case 'not_found':
      return classified(c.type, 'github.pullRequestNotFound')
    case 'validation_error':
      return classified(c.type, 'invalidUpdate', trimmed)
    case 'unknown':
      return classified(c.type, action, trimmed)
    case 'issues_disabled':
    case 'rate_limited':
    case 'network_error':
      return c
  }
}

// Pagination needs typed failures so an outage cannot masquerade as end-of-data.
export function classifyListPrsError(stderr: string): ClassifiedError {
  const c = classifyGhError(stderr)
  return { type: c.type, message: `Failed to load pull requests: ${stderr.trim()}` }
}

// Preserve classification while naming the rerun operation.
export function classifyRerunChecksError(stderr: string): ClassifiedError {
  const c = classifyGhError(stderr)
  const trimmed = stderr.trim()
  switch (c.type) {
    case 'permission_denied':
      return classified(c.type, 'github.rerunPermissionDenied')
    case 'not_found':
      return classified(c.type, 'github.rerunTargetNotFound')
    case 'validation_error':
      return classified(c.type, 'github.rerunRejected', trimmed)
    case 'issues_disabled':
    case 'unknown':
      return classified(c.type, 'github.rerunFailed', trimmed)
    case 'rate_limited':
    case 'network_error':
      return c
  }
}
