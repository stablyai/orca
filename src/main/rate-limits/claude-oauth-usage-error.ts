export class OAuthUsageError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly skipPtyFallback: boolean
  ) {
    super(message)
  }
}

export async function createOAuthUsageError(res: Response): Promise<OAuthUsageError> {
  return new OAuthUsageError(
    await describeOAuthUsageError(res),
    res.status,
    // Why: 429 is already the user-visible Claude usage API answer.
    // Falling through to /usage masks it with Claude 2.1's session-stats UI.
    res.status === 429
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
