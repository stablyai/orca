import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { getMainHttpClient } from '../network/http-client'
import { withSpan } from '../observability/tracer'
import type { RedmineReadError } from '../../shared/redmine-types'

export class RedmineApiError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

// Why: Redmine is self-hosted and often sits behind TLS inspection or proxies,
// so route requests through Electron's net.fetch (Chromium proxy/session state)
// exactly like Jira, not through undici's stale-socket fetch.
const REDMINE_API_USER_AGENT = 'Orca'
const REDMINE_MAX_REDIRECTS = 5

async function redmineFetch(url: string, init: RequestInit): Promise<Response> {
  return withSpan(
    'redmine.request',
    async (span) => {
      span.setAttribute('redmine.siteUrl', new URL(url).origin)
      const httpClient = getMainHttpClient()
      const proxySession = httpClient.proxySession()
      await ensureElectronProxyFromEnvironment({
        ...(proxySession ? { proxySession } : {}),
        probeUrl: url
      }).catch((error) => {
        span.addEvent('redmine.proxySetupFailed', {
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error)
        })
      })
      return redirectGuardedFetch(httpClient, url, init)
    },
    { kind: 'client' }
  )
}

// Why: follow redirects manually and validate every hop, so a redirect to a
// cleartext host can never receive the X-Redmine-API-Key header. Chromium's
// automatic redirect handling re-sends custom headers without target checks.
async function redirectGuardedFetch(
  httpClient: { fetch: (url: string, init: RequestInit) => Promise<Response> },
  url: string,
  init: RequestInit
): Promise<Response> {
  const initialOrigin = new URL(url).origin
  let current = url
  for (let hop = 0; hop < REDMINE_MAX_REDIRECTS; hop++) {
    assertSecureOrLoopbackUrl(current)
    const response = await httpClient.fetch(current, { ...init, redirect: 'manual' })
    const status = response.status
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location')
      if (!location) {
        return response
      }
      const next = new URL(location, current).toString()
      // Why: the API key is scoped to the configured site, so never forward it
      // to a different origin even over https.
      if (new URL(next).origin !== initialOrigin) {
        throw new RedmineApiError(`Refusing to follow a redirect to a different origin: ${next}`)
      }
      current = next
      continue
    }
    return response
  }
  throw new RedmineApiError(`Too many redirects while contacting ${url}`)
}

function buildHeaders(apiKey: string, init?: RequestInit): Headers {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('User-Agent', REDMINE_API_USER_AGENT)
  // Redmine REST API authenticates via this header; no username or password.
  headers.set('X-Redmine-API-Key', apiKey)
  return headers
}

async function readRedmineError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { errors?: string[]; message?: string }
    const messages = [
      ...(Array.isArray(data.errors) ? data.errors : []),
      ...(data.message ? [data.message] : [])
    ].filter(Boolean)
    if (messages.length > 0) {
      return messages.join('; ')
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `Redmine request failed (${response.status})`
}

export function normalizeRedmineUrl(value: string): string {
  let normalized = value.trim().replace(/\/+$/, '')
  // Why: schema-less input is common for self-hosted Redmine (like Jira's
  // normalizeJiraSiteUrl); default it to https rather than failing URL parse.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`
  }
  assertSecureOrLoopbackUrl(normalized)
  return normalized
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host === '[::1]' || host === '::1' || host.endsWith('.localhost')) {
    return true
  }
  return /^127(\.\d{1,3}){3}$/.test(host)
}

// Why: the API key travels cleartext, so require HTTPS for any non-loopback
// host (loopback local self-hosted setups stay usable). Shared by the URL
// normalizer and the redirect guard so a request can never send the key to a
// plaintext target.
export function assertSecureOrLoopbackUrl(urlString: string): void {
  const url = new URL(urlString)
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new RedmineApiError('Redmine servers must use HTTPS, except on loopback.')
  }
}

export async function redmineRequest<T>(
  siteUrl: string,
  apiKey: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = buildHeaders(apiKey, init)
  const response = await redmineFetch(`${normalizeRedmineUrl(siteUrl)}${path}`, {
    ...init,
    headers
  })
  if (!response.ok) {
    throw new RedmineApiError(await readRedmineError(response), response.status)
  }
  // A 204 carries no body; 200/201 return normal JSON.
  if (response.status === 204) {
    return null as T
  }
  return (await response.json()) as T
}

/** Classifies a thrown RedmineApiError/transport error into a serializable RedmineReadError. */
export function classifyRedmineError(error: unknown): RedmineReadError {
  if (error instanceof RedmineApiError) {
    if (error.status === 401 || error.status === 403) {
      return { type: 'auth', message: error.message, status: error.status }
    }
    if (error.status === 404) {
      return { type: 'not_found', message: error.message, status: error.status }
    }
    return { type: 'unknown', message: error.message, status: error.status }
  }
  const name = error instanceof Error ? error.name : typeof error
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'AbortError') {
    return { type: 'network', message: `Redmine request timed out: ${message}`, status: null }
  }
  return { type: 'network', message: `Redmine network error: ${message}`, status: null }
}
