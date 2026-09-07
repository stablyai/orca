// Why: a corrupt/hostile Retry-After must not gate usage refreshes for days.
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

export class OAuthUsageError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly skipPtyFallback: boolean,
    readonly retryAfterMs: number | null = null
  ) {
    super(message)
  }
}

export async function createOAuthUsageError(res: Response): Promise<OAuthUsageError> {
  return new OAuthUsageError(
    await describeOAuthUsageError(res),
    res.status,
    // Why: auth/rate-limit responses are already the user-visible usage API
    // answer. Falling through to /usage can spawn Claude Code needlessly.
    res.status === 401 || res.status === 403 || res.status === 429,
    res.status === 429 ? parseRetryAfterMs(res.headers.get('retry-after')) : null
  )
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) {
    return null
  }
  const seconds = Number(header)
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null
  }
  // Why: Retry-After may also be an HTTP-date (RFC 9110).
  const dateMs = Date.parse(header)
  if (!Number.isFinite(dateMs)) {
    return null
  }
  const delta = dateMs - Date.now()
  return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_MS) : null
}

async function describeOAuthUsageError(res: Response): Promise<string> {
  if (res.status === 429) {
    return 'Claude usage is rate limited right now.'
  }
  try {
    const data = (await res.json()) as { error?: { message?: string } }
    if (typeof data.error?.message === 'string' && data.error.message.trim()) {
      return data.error.message
    }
  } catch {
    // Ignore malformed error bodies and use the status fallback below.
  }
  return `OAuth API returned ${res.status}`
}
