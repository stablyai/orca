export class HostedReviewApiRequestError extends Error {
  readonly status: number | null
  // The request may have written remotely: it timed out or its JSON success body was unreadable.
  readonly unconfirmed: boolean

  constructor(message: string, options: { status?: number | null; unconfirmed?: boolean } = {}) {
    super(message)
    this.name = 'HostedReviewApiRequestError'
    this.status = options.status ?? null
    this.unconfirmed = options.unconfirmed ?? false
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
      // A non-JSON success (an SSO, proxy or sign-in HTML page) never reached the provider's API.
      if (!response.headers.get('content-type')?.includes('json')) {
        throw error
      }
      throw new HostedReviewApiRequestError('Could not read the successful response body', {
        status: response.status,
        unconfirmed: true
      })
    }
  } catch (error) {
    if (error instanceof HostedReviewApiRequestError) {
      throw error
    }
    // AbortSignal.timeout() rejects with a TimeoutError, not an AbortError.
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new HostedReviewApiRequestError('Request timed out', { unconfirmed: true })
    }
    throw error
  }
}
