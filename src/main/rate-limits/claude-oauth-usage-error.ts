import { classifyThrownUsageRequestError } from './usage-request-failure-kind'
import { parseUsageRetryAfterMs } from './usage-retry-after'

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

/** The usage request threw before a usable body: a transport failure or malformed JSON. */
export class ClaudeUsageRequestError extends Error {
  readonly failureKind: 'network' | 'parse'

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.failureKind = classifyThrownUsageRequestError(cause)
  }
}

export async function createOAuthUsageError(res: Response): Promise<OAuthUsageError> {
  return new OAuthUsageError(
    await describeOAuthUsageError(res),
    res.status,
    // Auth/rate-limit responses are authoritative; falling back to /usage would needlessly spawn Claude.
    res.status === 401 || res.status === 403 || res.status === 429,
    res.status === 429 ? parseUsageRetryAfterMs(res.headers.get('retry-after')) : null
  )
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
