import type { ClassifiedError } from '../../shared/classified-error'
import { GlabNonListResponseError } from './glab-api-response'

export function classifyGlabError(stderr: string): ClassifiedError {
  const s = stderr.toLowerCase()
  if (s.includes('http 403') || s.includes('forbidden') || s.includes('insufficient_scope')) {
    return {
      type: 'permission_denied',
      message: "You don't have permission to edit this issue. Check your GitLab token scopes."
    }
  }
  if (s.includes('http 404') || s.includes('project not found')) {
    return { type: 'not_found', message: 'Issue not found — it may have been deleted.' }
  }
  if (s.includes('http 422') || s.includes('unprocessable')) {
    return { type: 'validation_error', message: `Invalid update — ${stderr.trim()}` }
  }
  if (s.includes('rate limit') || s.includes('http 429')) {
    return {
      type: 'rate_limited',
      message: 'GitLab rate limit hit. Try again in a few minutes.'
    }
  }
  if (
    s.includes('timeout') ||
    s.includes('no such host') ||
    s.includes('network') ||
    s.includes('could not resolve host')
  ) {
    return { type: 'network_error', message: 'Network error — check your connection.' }
  }
  return { type: 'unknown', message: `Failed to update issue: ${stderr.trim()}` }
}

const LIST_READ_FAILURE = 'Failed to load issues'

// Reuse classification with read-specific copy for listing banners.
export function classifyListIssuesError(stderr: string): ClassifiedError {
  const c = classifyGlabError(stderr)
  const trimmed = stderr.trim()
  const readMessages: Record<ClassifiedError['type'], string> = {
    permission_denied:
      "You don't have permission to read issues for this project. Check your GitLab token scopes.",
    not_found: 'Project not found.',
    issues_disabled: 'Issues are disabled on this project.',
    validation_error: `Invalid request — ${trimmed}`,
    rate_limited: 'GitLab rate limit hit. Try again in a few minutes.',
    network_error: 'Network error — check your connection.',
    unknown: `${LIST_READ_FAILURE}: ${trimmed}`
  }
  return { type: c.type, message: readMessages[c.type] }
}

// Opaque content is not diagnostic; a title mentioning network timeout must not replace its body.
export function classifyListFetchError(err: unknown): ClassifiedError {
  if (err instanceof GlabNonListResponseError) {
    return { type: 'unknown', message: `${LIST_READ_FAILURE}: ${err.message}` }
  }
  return classifyListIssuesError(err instanceof Error ? err.message : String(err))
}

// Job-trace errors need Checks copy rather than issue-edit wording.
export function classifyJobLogError(stderr: string): ClassifiedError {
  const c = classifyGlabError(stderr)
  const trimmed = stderr.trim()
  const logMessages: Record<ClassifiedError['type'], string> = {
    permission_denied:
      "You don't have permission to read this job's log. Check your GitLab token scopes.",
    // A missing log is already reported as an empty log, so a 404 that reaches here
    // means the project itself is gone or invisible to this token.
    not_found: "Could not find this job's GitLab project.",
    issues_disabled: `Failed to load the job log: ${trimmed}`,
    validation_error: `Invalid request — ${trimmed}`,
    rate_limited: 'GitLab rate limit hit. Try again in a few minutes.',
    network_error: 'Network error — check your connection.',
    unknown: `Failed to load the job log: ${trimmed}`
  }
  return { type: c.type, message: logMessages[c.type] }
}

/** Missing/erased traces return empty logs, including ambiguous job 404s; explicit project failures remain errors. */
export function isMissingJobLogError(stderr: string): boolean {
  return classifyGlabError(stderr).type === 'not_found' && !/project\s+not\s+found/i.test(stderr)
}
