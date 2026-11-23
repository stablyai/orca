import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { getMainHttpClient } from '../network/http-client'
import { withSpan } from '../observability/tracer'
import { readFetchResponseJsonWithinLimit } from '../../shared/network/fetch-response-body'
import { createRequestConcurrencyQueue } from '../network/request-concurrency-queue'
import { withRequestDeadline } from '../network/request-deadline'
import { ClickUpApiError, toClickUpApiError, toClickUpDeadlineError } from './clickup-api-error'

export const CLICKUP_API_BASE_URL = 'https://api.clickup.com/api/v2'

const MAX_CONCURRENT = 4
// Together with the retry cap this keeps one request, and the operation around it, inside the renderer's 30s RPC timeout.
const REQUEST_DEADLINE_MS = 20_000
const MAX_RATE_LIMIT_RETRIES = 1
// ClickUp resets its per-minute window on the minute; a longer wait is surfaced instead of stalling the UI.
const MAX_RATE_LIMIT_WAIT_MS = 5_000
const FALLBACK_RATE_LIMIT_WAIT_MS = 2_000

const clickupRequestQueue = createRequestConcurrencyQueue(MAX_CONCURRENT, 'ClickUp')

async function clickupFetch(url: string, init: RequestInit): Promise<Response> {
  return withSpan(
    'clickup.request',
    async (span) => {
      const httpClient = getMainHttpClient()
      const proxySession = httpClient.proxySession()
      await ensureElectronProxyFromEnvironment({
        ...(proxySession ? { proxySession } : {}),
        probeUrl: url
      }).catch((error) => {
        span.addEvent('clickup.proxySetupFailed', {
          errorName: error instanceof Error ? error.name : typeof error
        })
      })
      return httpClient.fetch(url, init)
    },
    { kind: 'client' }
  )
}

function rateLimitWaitMs(response: Response): number {
  const reset = Number(response.headers.get('x-ratelimit-reset'))
  if (!Number.isFinite(reset) || reset <= 0) {
    return FALLBACK_RATE_LIMIT_WAIT_MS
  }
  return Math.max(0, reset * 1000 - Date.now())
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

type RequestAttempt<T> = { kind: 'done'; value: T } | { kind: 'rate-limited'; waitMs: number }

async function attemptRequest<T>(
  url: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<RequestAttempt<T>> {
  await clickupRequestQueue.acquire(signal)
  try {
    const response = await clickupFetch(url, init)
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined)
      return { kind: 'rate-limited', waitMs: rateLimitWaitMs(response) }
    }
    if (!response.ok) {
      throw await toClickUpApiError(response)
    }
    return { kind: 'done', value: await readFetchResponseJsonWithinLimit<T>(response) }
  } finally {
    clickupRequestQueue.release()
  }
}

/**
 * Calls the ClickUp REST API; the personal token goes in Authorization without a Bearer prefix.
 * `init.signal` cancels the call; a deadline bounds it even when the caller gives none.
 */
export async function clickupRequest<T>(
  token: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  if (init?.body !== undefined) {
    headers.set('Content-Type', 'application/json')
  }
  headers.set('Authorization', token)
  const url = `${CLICKUP_API_BASE_URL}${path}`
  const callerSignal = init?.signal ?? undefined
  try {
    return await withRequestDeadline(callerSignal, REQUEST_DEADLINE_MS, async (signal) => {
      for (let retry = 0; ; retry++) {
        // The token must never follow a redirect to another origin.
        const result = await attemptRequest<T>(
          url,
          { ...init, headers, signal, redirect: 'error' },
          signal
        )
        if (result.kind === 'done') {
          return result.value
        }
        if (retry >= MAX_RATE_LIMIT_RETRIES || result.waitMs > MAX_RATE_LIMIT_WAIT_MS) {
          throw new ClickUpApiError(
            `ClickUp rate limit reached. Try again in ${Math.max(1, Math.ceil(result.waitMs / 1000))} seconds.`,
            429
          )
        }
        // The slot is already released, so a throttled account does not hold the pool while waiting.
        await sleep(result.waitMs, signal)
      }
    })
  } catch (error) {
    throw toClickUpDeadlineError(
      error,
      callerSignal,
      (init?.method ?? 'GET').toUpperCase() !== 'GET'
    )
  }
}
