import { net, session } from 'electron'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { withSpan } from '../observability/tracer'
import type { PlaneWorkspace } from '../../shared/plane-types'
import { acquire, release } from './request-queue'
import {
  getThrottleWaitMs,
  noteRateLimitHeaders,
  noteRateLimited,
  rateLimitBudgetKey
} from './request-rate-limit'

// Why: Plane authenticates REST calls with a personal access token in
// X-API-Key; there is no cookie or XSRF path to satisfy. A non-browser UA
// keeps self-hosted reverse proxies from applying browser-only rules.
const PLANE_API_USER_AGENT = 'Orca'
const API_PREFIX = '/api/v1'
// Why: without a deadline one stalled socket (captive portal, dropped VPN, hung
// self-hosted proxy) holds a request-pool slot for the process lifetime.
const REQUEST_DEADLINE_MS = 30_000
// Retry-After can exceed a single sleep bound, so the throttle is re-checked in
// a loop rather than assumed cleared after one wait.
const MAX_THROTTLE_WAITS = 5

export type PlaneClientForWorkspace = {
  workspace: PlaneWorkspace
  apiToken: string
}

export class PlaneApiError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

export function isPlaneAuthError(error: unknown): boolean {
  // Why: Plane returns 403 for project/workspace permission gaps even when the
  // token is valid, so only 401 means the saved credential itself is bad.
  return error instanceof PlaneApiError && error.status === 401
}

/** Workspace-scoped path, e.g. `workspaces/acme/projects/`. */
export function workspacePath(workspace: Pick<PlaneWorkspace, 'slug'>, path: string): string {
  return `workspaces/${encodeURIComponent(workspace.slug)}/${path.replace(/^\/+/, '')}`
}

function describeErrorCause(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('cause' in error)) {
    return undefined
  }
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`
  }
  return cause === undefined ? undefined : String(cause)
}

async function planeFetch(url: string, init: RequestInit): Promise<Response> {
  return withSpan(
    'plane.request',
    async (span) => {
      span.setAttribute('plane.origin', new URL(url).origin)
      await ensureElectronProxyFromEnvironment({
        proxySession: session.defaultSession,
        probeUrl: url
      }).catch((error) => {
        span.addEvent('plane.proxySetupFailed', {
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error)
        })
      })
      try {
        // Why: Electron's network stack follows Chromium proxy/session state,
        // avoiding undici's stale keep-alive sockets after VPN path changes.
        return await net.fetch(url, init)
      } catch (error) {
        span.setAttribute(
          'plane.transportErrorName',
          error instanceof Error ? error.name : typeof error
        )
        span.setAttribute(
          'plane.transportErrorMessage',
          error instanceof Error ? error.message : String(error)
        )
        const cause = describeErrorCause(error)
        if (cause) {
          span.setAttribute('plane.transportErrorCause', cause)
        }
        throw error
      }
    },
    { kind: 'client' }
  )
}

function buildHeaders(apiToken: string, init?: RequestInit): Headers {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('User-Agent', PLANE_API_USER_AGENT)
  headers.set('X-API-Key', apiToken)
  return headers
}

/** Abortable so a cancelled search does not leave its caller parked for a
 *  throttle window with no way out. */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError())
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(createAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function createAbortError(): Error {
  const error = new Error('Plane request aborted')
  error.name = 'AbortError'
  return error
}

/** Bounds a request so a stalled socket releases its pool slot. Mirrors the
 *  deadline the Jira provider wraps its reads in. */
function withDeadline(signal: AbortSignal | null | undefined): {
  signal: AbortSignal
  done: () => void
} {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(createDeadlineError()), REQUEST_DEADLINE_MS)
  const forward = (): void => controller.abort(signal?.reason)
  signal?.addEventListener('abort', forward, { once: true })
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forward)
    }
  }
}

function createDeadlineError(): Error {
  const error = new Error(`Plane did not respond within ${REQUEST_DEADLINE_MS}ms`)
  error.name = 'TimeoutError'
  return error
}

async function readPlaneError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as {
      error?: unknown
      detail?: unknown
      message?: unknown
    } & Record<string, unknown>
    const primary = [data.error, data.detail, data.message].find(
      (value) => typeof value === 'string' && value.length > 0
    )
    if (typeof primary === 'string') {
      return primary
    }
    // Field-level validation errors arrive as { field: ["msg", ...] }.
    const fieldErrors = Object.entries(data)
      .filter(([, value]) => Array.isArray(value))
      .map(([field, value]) => `${field}: ${(value as unknown[]).join(', ')}`)
    if (fieldErrors.length > 0) {
      return fieldErrors.join('; ')
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `Plane request failed (${response.status})`
}

/**
 * Takes a request-pool slot only while the rate budget is clear.
 *
 * Checking the budget before queueing is not enough: requests already waiting
 * on the pool passed that check while the allowance was positive, and an
 * earlier response can exhaust it before they are released. Re-checking after
 * acquire — and giving the slot back if the budget went away — is what stops a
 * burst from escaping the limiter at exactly the boundary it protects. The
 * sleep happens without holding a slot so a throttled request cannot starve
 * the pool.
 */
async function admit(budgetKey: string, signal?: AbortSignal | null): Promise<void> {
  for (let attempt = 0; attempt < MAX_THROTTLE_WAITS; attempt++) {
    const waitMs = getThrottleWaitMs(budgetKey)
    if (waitMs > 0) {
      await sleep(waitMs + jitterMs(), signal)
      continue
    }
    await acquire(signal ?? undefined)
    if (getThrottleWaitMs(budgetKey) <= 0) {
      return
    }
    release()
  }
  throw new PlaneApiError(
    'Plane is still rate limiting this API token. Try again in a minute.',
    429
  )
}

async function execute(
  budgetKey: string,
  url: string,
  apiToken: string,
  init: RequestInit | undefined,
  attempt: number
): Promise<unknown> {
  await admit(budgetKey, init?.signal)
  const deadline = withDeadline(init?.signal)
  let response: Response
  try {
    response = await planeFetch(url, {
      ...init,
      headers: buildHeaders(apiToken, init),
      signal: deadline.signal
    })
  } finally {
    deadline.done()
    release()
  }

  noteRateLimitHeaders(budgetKey, response.headers)

  if (response.status === 429 && attempt === 0) {
    noteRateLimited(budgetKey, response.headers)
    return execute(budgetKey, url, apiToken, init, attempt + 1)
  }
  if (!response.ok) {
    // Why: only the first 429 took the retry path above. Without this a
    // repeated 429 -- especially one carrying no x-ratelimit-remaining -- would
    // leave the budget clear and the next caller would send immediately.
    if (response.status === 429) {
      noteRateLimited(budgetKey, response.headers)
    }
    throw new PlaneApiError(await readPlaneError(response), response.status)
  }
  if (response.status === 204) {
    return null
  }
  return response.json()
}

/**
 * Used by connect/test flows, before a workspace record exists. The rate-limit
 * budget is keyed by the token digest, so a connect attempt shares the same
 * allowance as later requests made with that token.
 */
export async function requestWithCredentials(
  baseUrl: string,
  apiToken: string,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  return execute(
    rateLimitBudgetKey(apiToken),
    `${baseUrl}${API_PREFIX}/${path.replace(/^\/+/, '')}`,
    apiToken,
    init,
    0
  )
}

export async function planeRequest<T>(
  client: PlaneClientForWorkspace,
  path: string,
  init?: RequestInit
): Promise<T> {
  const url = `${client.workspace.baseUrl}${API_PREFIX}/${path.replace(/^\/+/, '')}`
  return (await execute(rateLimitBudgetKey(client.apiToken), url, client.apiToken, init, 0)) as T
}

// Spreads the wake-ups of everything parked on one budget; without it they all
// fire together and re-exhaust the per-minute allowance immediately.
function jitterMs(): number {
  return Math.floor(Math.random() * 500)
}

export function buildQuery(query: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {
      continue
    }
    params.set(key, Array.isArray(value) ? value.join(',') : String(value))
  }
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}
