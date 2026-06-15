import type { ClassifiedError } from '../../shared/types'

// ── Error classification ─────────────────────────────────────────────
// Why: gh CLI surfaces API errors as unstructured stderr. This helper maps
// known patterns to typed errors so callers can show user-friendly messages.
export function classifyGhError(stderr: string): ClassifiedError {
  const s = stderr.toLowerCase()
  if (s.includes('http 403') || s.includes('resource not accessible')) {
    return {
      type: 'permission_denied',
      message: "You don't have permission to edit this issue. Check your GitHub token scopes."
    }
  }
  // Why: the full gh message is "Could not resolve to a Repository with the
  // name ...". Matching the substring 'could not resolve' alone would also
  // capture DNS failures like "could not resolve host: api.github.com" and
  // misclassify them as not_found. Anchor on the 'repository' qualifier so
  // DNS errors fall through to the network_error branch below.
  if (s.includes('http 404') || s.includes('could not resolve to a repository')) {
    return { type: 'not_found', message: 'Issue not found — it may have been deleted.' }
  }
  // Why: `gh issue list` prints "the '<owner>/<repo>' repository has disabled
  // issues" when Issues are turned off in repo settings (common on forks). This
  // hits during feature-2 when a user flips the selector to an origin fork —
  // without a dedicated branch the raw "Command failed: gh issue list …" line
  // leaks verbatim into the banner via the `unknown` fallback.
  if (s.includes('has disabled issues')) {
    return { type: 'issues_disabled', message: 'Issues are disabled on this repository.' }
  }
  if (s.includes('http 422') || s.includes('validation failed')) {
    return { type: 'validation_error', message: `Invalid update — ${stderr.trim()}` }
  }
  if (s.includes('rate limit')) {
    return {
      type: 'rate_limited',
      message: 'GitHub rate limit hit. Try again in a few minutes.'
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

// Why: classifyGhError's copy is phrased for edit/update operations, but
// `listIssues` is a read op and the renderer interpolates err.message verbatim
// into a read-context banner. Rewrite the message for read contexts while
// keeping the typed classification so callers/telemetry are unaffected.
export function classifyListIssuesError(stderr: string): ClassifiedError {
  const c = classifyGhError(stderr)
  const trimmed = stderr.trim()
  // Why: provide an explicit entry for every `ClassifiedError['type']` value
  // (even when the copy matches the generic fallback) so the read-context
  // rewrite is complete and any newly added error type surfaces as a
  // TypeScript error rather than silently falling through to edit-phrased copy.
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
