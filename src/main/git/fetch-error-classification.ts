import { isExecKilledError } from '../../shared/git-remote-error'

export function isMissingRemoteRefGitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return (
    normalized.includes('could not find remote ref') ||
    normalized.includes("couldn't find remote ref")
  )
}

// Why: allowlist, not blocklist — soft-keeping a durable review-head ref is
// only safe when the fetch plainly died in transport. A deleted PR head, auth
// failure, or stale-relay method-not-found must surface, or the caller checks
// out a dead/unauthorized tip. Covers raw git stderr and the relay's
// normalized messages ("Network error. Check your connection.", "… timed out").
const TRANSIENT_FETCH_ERROR_PATTERNS = [
  'timed out',
  'timeout',
  'operation was aborted',
  'network error',
  'network is unreachable',
  'could not resolve host',
  'temporary failure in name resolution',
  'connection refused',
  'connection reset',
  'connection closed',
  'early eof',
  'remote end hung up',
  'the requested url returned error: 5'
]

export function isTransientReviewHeadFetchError(error: unknown): boolean {
  if (isMissingRemoteRefGitError(error)) {
    return false
  }
  if (isExecKilledError(error)) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return TRANSIENT_FETCH_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern))
}
