import type { PRRefreshErrorType } from '../../shared/github/pull-request-refresh-types'
import { classifyGitHubUnavailable } from '../../shared/github/api-availability'
import { extractExecError } from '../git/exec-error'

/** Classify runner failures before UI rendering; rate-limit 403s precede permissions, and repo 404s precede network heuristics. */
export function classifyPRRefreshError(err: unknown): PRRefreshErrorType {
  // Runner diagnostics may live only on stdout/stderr; retain structured spawn codes too.
  const { stderr, stdout } = extractExecError(err)
  const message = err instanceof Error ? err.message : String(err)
  const lower = `${message}\n${stderr}\n${stdout}`.toLowerCase()
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code ?? '').toLowerCase()
      : ''

  // Secondary limits may mention abuse or Retry-After without the phrase rate limit.
  const isHttp429 = lower.includes('http 429') || lower.includes('429 too many requests')
  const isHttp403 = lower.includes('http 403')
  const hasRetryAfter = lower.includes('retry-after')
  if (
    isHttp429 ||
    lower.includes('secondary rate limit') ||
    lower.includes('abuse detection') ||
    lower.includes('abuse-rate-limits') ||
    lower.includes('you have triggered an abuse') ||
    ((isHttp403 || isHttp429) && hasRetryAfter) ||
    lower.includes('api rate limit exceeded') ||
    lower.includes('rate limit')
  ) {
    return 'rate_limited'
  }
  // Match repository failures before incidental connectivity wording.
  if (lower.includes('http 404') || lower.includes('could not resolve to a repository')) {
    return 'repo_unavailable'
  }
  const unavailable = classifyGitHubUnavailable(lower)
  if (unavailable) {
    return unavailable
  }
  // Require structured codes or full phrases; a repository named network-* is not a network failure.
  const networkCodes = new Set([
    'etimedout',
    'econnreset',
    'econnrefused',
    'enotfound',
    'eai_again',
    'enetunreach',
    'enetdown'
  ])
  if (
    networkCodes.has(code) ||
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('eai_again') ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('could not resolve host') ||
    lower.includes('no such host') ||
    lower.includes('network is unreachable') ||
    lower.includes('network is down') ||
    lower.includes('network error') ||
    lower.includes('connection refused') ||
    lower.includes('connection reset')
  ) {
    return 'network'
  }
  if (isHttp403 || lower.includes('resource not accessible')) {
    return 'permission'
  }
  // Prefer structured launch codes so paths containing gh cannot imply a missing executable.
  if (
    code === 'enoent' ||
    lower.includes('spawn gh enoent') ||
    lower.includes('gh: command not found') ||
    lower.includes("'gh' is not recognized")
  ) {
    return 'gh_unavailable'
  }
  // Full auth phrases avoid matching author/authored.
  if (
    lower.includes('http 401') ||
    lower.includes('unauthorized') ||
    lower.includes('authorization') ||
    lower.includes('authentication') ||
    lower.includes('bad credentials') ||
    lower.includes('gh auth') ||
    /\b(login|credentials?)\b/i.test(lower)
  ) {
    return 'auth'
  }
  return 'unknown'
}

export function safePRRefreshErrorMessage(errorType: PRRefreshErrorType): string {
  switch (errorType) {
    case 'rate_limited':
      return 'GitHub rate limit is low. Try again after the limit resets.'
    case 'auth':
      return 'GitHub authentication is unavailable. Check your gh login.'
    case 'network':
      return 'GitHub is unreachable right now. Check your network and try again.'
    case 'server_error':
      return "GitHub's API is temporarily unavailable (server error). This is a GitHub-side issue."
    case 'permission':
      return 'GitHub did not allow access to this pull request.'
    case 'repo_unavailable':
      return 'The GitHub repository is unavailable or cannot be resolved.'
    case 'gh_unavailable':
      return 'GitHub CLI is unavailable.'
    case 'unknown':
      return 'GitHub pull request refresh failed.'
  }
}
