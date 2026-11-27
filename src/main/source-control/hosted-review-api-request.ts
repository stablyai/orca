export class HostedReviewApiRequestError extends Error {
  readonly status: number | null
  readonly timedOut: boolean
  readonly unconfirmed: boolean

  constructor(
    message: string,
    options: {
      status?: number | null
      timedOut?: boolean
      unconfirmed?: boolean
      cause?: unknown
    } = {}
  ) {
    super(message, { cause: options.cause })
    this.name = 'HostedReviewApiRequestError'
    this.status = options.status ?? null
    this.timedOut = options.timedOut ?? false
    this.unconfirmed = options.unconfirmed ?? this.timedOut
  }
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

export async function requestHostedReviewJson<T>(
  url: URL,
  init: Omit<RequestInit, 'signal'>,
  timeoutMs: number
): Promise<T> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) {
      const body = await readResponseText(response)
      throw new HostedReviewApiRequestError(body || response.statusText, {
        status: response.status
      })
    }
    try {
      return (await response.json()) as T
    } catch (error) {
      // A successful write can outlive a truncated or unreadable response body.
      throw new HostedReviewApiRequestError(
        'Could not read the successful review creation response',
        {
          status: response.status,
          unconfirmed: true,
          timedOut: error instanceof Error && error.name === 'TimeoutError',
          cause: error
        }
      )
    }
  } catch (error) {
    if (error instanceof HostedReviewApiRequestError) {
      throw error
    }
    // AbortSignal.timeout() rejects with a TimeoutError, not an AbortError.
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new HostedReviewApiRequestError('Request timed out', { timedOut: true })
    }
    throw error
  }
}
