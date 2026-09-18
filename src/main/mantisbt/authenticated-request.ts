import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { getMainHttpClient } from '../network/http-client'
import { withSpan } from '../observability/tracer'
import type { MantisBTAuthScheme, MantisBTSite } from '../../shared/mantisbt-types'

// Why: matches Jira's authenticated-request.ts choice of a non-browser
// User-Agent — Electron's net.fetch otherwise sends a Chrome UA, and some
// MantisBT deployments sit behind reverse-proxy rules keyed on it.
const MANTISBT_API_USER_AGENT = 'Orca'

export type MantisBTClientForSite = {
  site: MantisBTSite
  authorization: string
}

// Why: a server without URL rewriting (Apache mod_rewrite/nginx try_files)
// needs `index.php` in the REST path or every request 404s.
export function apiBasePath(usePhpIndexPath: boolean): string {
  return usePhpIndexPath ? '/api/rest/index.php' : '/api/rest'
}

export class MantisBTApiError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

// MantisBT REST auth is a single per-user API token. The RFC 6750 `Bearer`
// scheme is current as of 2.29.0; older servers don't recognize it and 401
// unless the token is sent bare (the pre-2.29.0 form, still accepted by
// current MantisBT for backwards compatibility). connect() probes both.
export function authHeader(apiToken: string, scheme: MantisBTAuthScheme): string {
  return scheme === 'bearer' ? `Bearer ${apiToken}` : apiToken
}

function describeErrorCause(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('cause' in error)) {
    return undefined
  }
  const cause = error.cause
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`
  }
  return cause === undefined ? undefined : String(cause)
}

async function mantisBTFetch(url: string, init: RequestInit): Promise<Response> {
  return withSpan(
    'mantisBT.request',
    async (span) => {
      span.setAttribute('mantisBT.siteUrl', new URL(url).origin)
      const httpClient = getMainHttpClient()
      const proxySession = httpClient.proxySession()
      await ensureElectronProxyFromEnvironment({
        ...(proxySession ? { proxySession } : {}),
        probeUrl: url
      }).catch((error) => {
        span.addEvent('mantisBT.proxySetupFailed', {
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error)
        })
      })
      try {
        // Why the port: on the desktop this is Electron's net.fetch, which follows
        // Chromium proxy/session state and avoids undici's stale keep-alive sockets
        // after VPN path changes. A host without Chromium gets Node's fetch instead.
        return await httpClient.fetch(url, init)
      } catch (error) {
        span.setAttribute(
          'mantisBT.transportErrorName',
          error instanceof Error ? error.name : typeof error
        )
        span.setAttribute(
          'mantisBT.transportErrorMessage',
          error instanceof Error ? error.message : String(error)
        )
        const cause = describeErrorCause(error)
        if (cause) {
          span.setAttribute('mantisBT.transportErrorCause', cause)
        }
        throw error
      }
    },
    { kind: 'client' }
  )
}

export async function requestWithCredentials(
  siteUrl: string,
  apiToken: string,
  path: string,
  scheme: MantisBTAuthScheme,
  init?: RequestInit
): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('User-Agent', MANTISBT_API_USER_AGENT)
  headers.set('Authorization', authHeader(apiToken, scheme))
  const response = await mantisBTFetch(`${siteUrl}${path}`, {
    ...init,
    headers
  })
  if (!response.ok) {
    throw new MantisBTApiError(await readMantisBTError(response), response.status)
  }
  if (response.status === 204) {
    return null
  }
  return response.json()
}

export type MantisBTConnectProbeResult = {
  data: unknown
  authScheme: MantisBTAuthScheme
  usePhpIndexPath: boolean
}

// Why: tried in this fixed order regardless of which error each attempt
// hits — a one-time connect probe, so the extra round trips are cheap and
// the fixed order is simpler to reason about (and test) than branching the
// next attempt on the specific status code of the last one.
const CONNECT_PROBE_COMBOS: readonly {
  authScheme: MantisBTAuthScheme
  usePhpIndexPath: boolean
}[] = [
  { authScheme: 'bearer', usePhpIndexPath: false },
  { authScheme: 'bearer', usePhpIndexPath: true },
  { authScheme: 'legacy', usePhpIndexPath: false },
  { authScheme: 'legacy', usePhpIndexPath: true }
]

// Why: MantisBT deployments vary independently on auth scheme (see
// authHeader) and REST path style (see apiBasePath) — neither is knowable
// from the site URL alone. Probes GET /users/me with each combination and
// keeps the first that succeeds; the caller persists it on the site so
// later requests (testConnection, listIssues, ...) skip straight to it.
export async function probeMantisBTConnection(
  siteUrl: string,
  apiToken: string
): Promise<MantisBTConnectProbeResult> {
  let lastError: unknown
  for (const combo of CONNECT_PROBE_COMBOS) {
    try {
      const data = await requestWithCredentials(
        siteUrl,
        apiToken,
        `${apiBasePath(combo.usePhpIndexPath)}/users/me`,
        combo.authScheme
      )
      return { data, ...combo }
    } catch (error) {
      lastError = error
      // Why: a non-auth, non-path failure (network error, 5xx, ...) is the
      // same regardless of which combo sent it, so surface it immediately
      // instead of repeating it three more times.
      if (!(error instanceof MantisBTApiError) || (error.status !== 401 && error.status !== 404)) {
        throw error
      }
    }
  }
  throw lastError
}

async function readMantisBTError(response: Response): Promise<string> {
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: response.json() returns `any`; `data.message` is read with a truthy check before use.
    const data = (await response.json()) as { message?: string }
    if (data.message) {
      return data.message
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `MantisBT request failed (${response.status})`
}

export async function mantisBTRequest<T>(
  client: MantisBTClientForSite,
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('User-Agent', MANTISBT_API_USER_AGENT)
  headers.set('Authorization', client.authorization)
  const response = await mantisBTFetch(`${client.site.siteUrl}${path}`, {
    ...init,
    headers
  })
  if (!response.ok) {
    throw new MantisBTApiError(await readMantisBTError(response), response.status)
  }
  if (response.status === 204) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: HTTP 204 has no body; every caller's `T` is expected to tolerate null for a no-content response.
    return null as T
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: response.json() returns `any`; `T` is the caller-declared expected shape for this endpoint, the same trust boundary as every typed REST client in this codebase.
  return (await response.json()) as T
}
