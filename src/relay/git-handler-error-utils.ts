// Why: the relay is a standalone deployable that cannot import from src/main.
// We mirror normalizeGitErrorMessage from src/main/git/remote.ts here so SSH
// users see the same actionable guidance on push/pull/fetch failures as local
// users do. Keep these two copies in sync until a shared module is added.
const CREDENTIAL_URL_PATTERN = /https?:\/\/[^\s/@]+:[^\s/@]+@/g

function stripCredentialsFromMessage(message: string): string {
  return message.replace(CREDENTIAL_URL_PATTERN, '')
}

function extractTailLine(message: string): string {
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.at(-1) ?? message
}

export function normalizeGitErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Git remote operation failed.'
  }

  const raw = error.message

  if (raw.includes('non-fast-forward') || raw.includes('fetch first')) {
    return 'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.'
  }

  if (raw.includes('could not read Username') || raw.includes('Authentication failed')) {
    return 'Authentication failed. Check your remote credentials.'
  }

  if (raw.includes('Could not resolve host') || raw.includes('Network is unreachable')) {
    return 'Network error. Check your connection.'
  }

  if (raw.includes('no tracking information') || raw.includes('no upstream')) {
    return 'Branch has no upstream. Publish the branch first.'
  }

  return stripCredentialsFromMessage(extractTailLine(raw))
}

// Why: we only swallow the 'no upstream configured' error — that's an expected
// state, not a failure. Other errors (auth, corruption, network) should surface
// to the user so they can act on them.
const NO_UPSTREAM_ERROR_PATTERN = /no upstream|HEAD@\{u\}|does not point/i

export function isNoUpstreamError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return NO_UPSTREAM_ERROR_PATTERN.test(error.message)
}
