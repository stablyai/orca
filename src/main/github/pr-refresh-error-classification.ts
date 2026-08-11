import type { PRRefreshErrorType } from '../../shared/types'
import { classifyGitHubUnavailable } from '../../shared/github-api-availability'
import { extractExecError } from '../git/exec-error'

/**
 * Sanitization boundary for GitHub PR-refresh failures. Maps a raw runner/CLI
 * error to a stable {@link PRRefreshErrorType}; the renderer turns that into
 * classified copy so raw stderr / env values never reach the UI.
 *
 * Classification order (see docs/reference/pr-panel-refresh-guidance.md):
 * HTTP 429 / secondary rate limit → primary rate limit → repo_unavailable (404) →
 * network → permission (403) → gh_unavailable → auth → unknown. GitHub returns
 * 403 OR 429 for both primary and secondary limits, so the http-403 permission
 * branch must run only after the rate-limit checks. 404 is matched before the
 * network branch so a repository error whose message happens to contain a
 * substring like "network" is not misread as a connectivity failure. Auth and
 * network detection avoid broad substrings (e.g. "auth" inside "author", or a
 * repo name containing "network") in favor of structured codes and full phrases.
 */
export function classifyPRRefreshError(err: unknown): PRRefreshErrorType {
  // Why: the git/gh runner keeps diagnostics on `.stderr`/`.stdout` separate
  // from `.message` (which can be just "gh exited with 1."). Reading message
  // alone would misclassify a real "HTTP 403" / "HTTP 404" as `unknown`, so a
  // hard error would be treated as transient. Combine all three for substring
  // detection while still preferring the structured spawn `code`.
  const { stderr, stdout } = extractExecError(err)
  const message = err instanceof Error ? err.message : String(err)
  const lower = `${message}\n${stderr}\n${stdout}`.toLowerCase()
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code ?? '').toLowerCase()
      : ''

  // Rate limits first: a 429 is always a rate-limit signal; secondary limits also
  // arrive as abuse-mechanism phrasing or a 403/429 carrying Retry-After, none of
  // which contain "rate limit".
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
  // Repository resolution failures (404) rank before the network branch: a "could
  // not resolve to a Repository" message must not be captured by a connectivity
  // heuristic, and matching 404 first isolates it from any incidental substring.
  if (lower.includes('http 404') || lower.includes('could not resolve to a repository')) {
    return 'repo_unavailable'
  }
  // Why: keep GitHub 5xx/network attribution aligned with other GitHub surfaces.
  const unavailable = classifyGitHubUnavailable(lower)
  if (unavailable) {
    return unavailable
  }
  // Network: structured error codes and full connectivity phrases only. Never a
  // bare "network" substring — a repo/branch/message containing "network" is not
  // evidence of a connectivity failure.
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
  // gh CLI launch failure: prefer the structured spawn error code over a broad
  // substring so a repo path merely containing "gh" is not misclassified.
  if (
    code === 'enoent' ||
    lower.includes('spawn gh enoent') ||
    lower.includes('gh: command not found') ||
    lower.includes("'gh' is not recognized")
  ) {
    return 'gh_unavailable'
  }
  // Auth last: match full auth phrases and a 401, never a bare "auth" substring
  // that also fires on "author"/"authored". "unauthorized"/"authorization" are
  // long enough not to collide with "author".
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

/** Stable, non-destructive fallback message for a classified refresh error. */
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
