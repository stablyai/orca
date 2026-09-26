import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { getMainHttpClient } from '../network/http-client'
import { withSpan } from '../observability/tracer'
import { recordRateLimit } from './request-queue'
import type { BusinessmapDomain, BusinessmapSite } from '../../shared/businessmap-types'

export const BUSINESSMAP_SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*$/i
const BUSINESSMAP_API_USER_AGENT = 'Orca'

export type BusinessmapClientForSite = {
  site: BusinessmapSite
  apiKey: string
}

export type ApiRecord = Record<string, unknown>

// Base URL for the v2 API; throws on an invalid subdomain so callers fail fast.
export function baseUrl(site: BusinessmapSite): string {
  if (!BUSINESSMAP_SUBDOMAIN_PATTERN.test(site.subdomain)) {
    throw new Error('Enter a valid Businessmap subdomain.')
  }
  const domain: BusinessmapDomain =
    site.domain === 'kanbanize.com' ? 'kanbanize.com' : 'businessmap.io'
  return `https://${site.subdomain}.${domain}/api/v2`
}

export class BusinessmapApiError extends Error {
  status: number | null
  code: string | null
  retryAfterSeconds: number | null

  constructor(
    message: string,
    status: number | null = null,
    code: string | null = null,
    retryAfterSeconds: number | null = null
  ) {
    super(message)
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

// A002 is the API's auth-rejected code; only it (or HTTP 401) means the key is bad.
export function isAuthError(error: unknown): boolean {
  return error instanceof BusinessmapApiError && (error.status === 401 || error.code === 'A002')
}

// RL02 means the request was rejected before running, so waiting out retry_after is safe.
export function isRateLimitError(error: unknown): boolean {
  return error instanceof BusinessmapApiError && (error.status === 429 || error.code === 'RL02')
}

function redactSecrets(value: string): string {
  return value.replace(/("?apikey"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[REDACTED]')
}

function describeErrorCause(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('cause' in error)) {
    return undefined
  }
  if (error instanceof Error) {
    const cause = error.cause
    if (cause instanceof Error) {
      return `${cause.name}: ${cause.message}`
    }
    return cause === undefined ? undefined : String(cause)
  }
  return undefined
}

async function businessmapFetch(url: string, init: RequestInit): Promise<Response> {
  return withSpan(
    'businessmap.request',
    async (span) => {
      span.setAttribute('businessmap.siteUrl', new URL(url).origin)
      const httpClient = getMainHttpClient()
      const proxySession = httpClient.proxySession()
      await ensureElectronProxyFromEnvironment({
        ...(proxySession ? { proxySession } : {}),
        probeUrl: url
      }).catch((error) => {
        span.addEvent('businessmap.proxySetupFailed', {
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error)
        })
      })
      try {
        // Why the port: on the desktop this is Electron's net.fetch, which follows
        // Chromium proxy/session state. A host without Chromium gets Node's fetch.
        return await httpClient.fetch(url, init)
      } catch (error) {
        span.setAttribute(
          'businessmap.transportErrorName',
          error instanceof Error ? error.name : typeof error
        )
        span.setAttribute(
          'businessmap.transportErrorMessage',
          error instanceof Error ? error.message : String(error)
        )
        const cause = describeErrorCause(error)
        if (cause) {
          span.setAttribute('businessmap.transportErrorCause', cause)
        }
        throw error
      }
    },
    { kind: 'client' }
  )
}

type ParsedApiError = {
  message: string
  code: string | null
  retryAfterSeconds: number | null
}

async function readBusinessmapError(response: Response): Promise<ParsedApiError> {
  const retryAfterHeader = response.headers.get('retry-after')
  const headerRetry = retryAfterHeader !== null ? Number(retryAfterHeader) : Number.NaN
  const fallbackRetry = Number.isFinite(headerRetry) ? headerRetry : null
  try {
    const data: unknown = await response.json()
    const root = asRecord(data)
    // Why: the API nests failures as {error:{code,message,details}}; some edges
    // return a bare {message} instead, so accept both before falling back.
    const nested = asRecord(root.error)
    const code = asString(nested.code || root.code)
    const details = asRecord(nested.details)
    const detailRetry = asNumber(details.retry_after)
    const message = asString(nested.message) || asString(root.message) || asString(root.error) || ''
    if (message) {
      return {
        message: redactSecrets(message),
        code: code || null,
        retryAfterSeconds: detailRetry ?? fallbackRetry
      }
    }
  } catch {
    // Fall through to status text.
  }
  const statusMessage = response.statusText || `Businessmap request failed (${response.status})`
  return { message: redactSecrets(statusMessage), code: null, retryAfterSeconds: fallbackRetry }
}

function apiKeyHeaders(apiKey: string, init?: RequestInit): Headers {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('User-Agent', BUSINESSMAP_API_USER_AGENT)
  headers.set('apikey', apiKey)
  return headers
}

async function throwForResponse(response: Response): Promise<never> {
  recordRateLimit(response.headers)
  const parsed = await readBusinessmapError(response)
  throw new BusinessmapApiError(
    parsed.message,
    response.status,
    parsed.code,
    parsed.retryAfterSeconds
  )
}

// One-shot request with explicit credentials, used by connect before a site is stored.
export async function requestWithCredentials(
  site: BusinessmapSite,
  apiKey: string,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  const response = await businessmapFetch(`${baseUrl(site)}${path}`, {
    ...init,
    headers: apiKeyHeaders(apiKey, init)
  })
  recordRateLimit(response.headers)
  if (!response.ok) {
    await throwForResponse(response)
  }
  if (response.status === 204) {
    return null
  }
  return response.json()
}

// One-shot request for a stored site; never retries (writes must not repeat).
export async function businessmapRequest(
  client: BusinessmapClientForSite,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  const response = await businessmapFetch(`${baseUrl(client.site)}${path}`, {
    ...init,
    headers: apiKeyHeaders(client.apiKey, init)
  })
  recordRateLimit(response.headers)
  if (!response.ok) {
    await throwForResponse(response)
  }
  if (response.status === 204) {
    return null
  }
  return response.json()
}

// Small delay between read retries; single call site below.
function retryDelay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

// Retrying read with backoff: 429 waits out retry_after, 5xx backs off. Never use for writes.
export async function businessmapRead(
  client: BusinessmapClientForSite,
  path: string,
  init?: RequestInit,
  maxRetries = 3
): Promise<unknown> {
  const attempts = Math.max(1, maxRetries)
  let lastError: unknown = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await businessmapRequest(client, path, init)
    } catch (error) {
      lastError = error
      const retryable =
        isRateLimitError(error) ||
        (error instanceof BusinessmapApiError && error.status !== null && error.status >= 500)
      if (!retryable || attempt === attempts - 1) {
        throw error
      }
      const backoff =
        error instanceof BusinessmapApiError && isRateLimitError(error)
          ? (error.retryAfterSeconds ?? 1) * 1000
          : 500 * 2 ** attempt
      await retryDelay(Math.max(0, backoff))
    }
  }
  throw lastError
}

export function asRecord(value: unknown): ApiRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const record: ApiRecord = {}
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry
  }
  return record
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

// Unwraps {data:[...]} and paginated {data:{pagination,data:[...]}} envelopes.
export function unwrapList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload
  }
  const data = asRecord(payload).data
  if (Array.isArray(data)) {
    return data
  }
  const nested = asRecord(data).data
  return Array.isArray(nested) ? nested : []
}

// Unwraps a single {data:{...}} envelope, falling back to the bare object.
export function unwrapSingle(payload: unknown): ApiRecord {
  const list = unwrapList(payload)
  if (list.length > 0) {
    return asRecord(list[0])
  }
  const data = asRecord(payload).data
  return asRecord(data && typeof data === 'object' && !Array.isArray(data) ? data : payload)
}
