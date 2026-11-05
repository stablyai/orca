export class HostedReviewApiRequestError extends Error {
  readonly status: number | null
  readonly timedOut: boolean

  constructor(message: string, options: { status?: number | null; timedOut?: boolean } = {}) {
    super(message)
    this.name = 'HostedReviewApiRequestError'
    this.status = options.status ?? null
    this.timedOut = options.timedOut ?? false
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
    return (await response.json()) as T
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
