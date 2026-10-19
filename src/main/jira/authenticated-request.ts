import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { getMainHttpClient } from '../network/http-client'
import { withSpan } from '../observability/tracer'
import type { JiraAuthType, JiraSite } from '../../shared/jira-types'
import { isJiraGatewayBaseUrl } from './gateway-base-url'
import { JiraApiError, toJiraApiError } from './jira-api-error'

export { JiraApiError } from './jira-api-error'
import {
  readFetchResponseBytesWithinLimit,
  readFetchResponseJsonWithinLimit
} from '../../shared/fetch-response-body'

// Why: Atlassian's XSRF filter rejects POST/PUT REST calls that carry a browser
// User-Agent, failing them with "XSRF check failed" even under API-token auth.
// Electron's net.fetch sends a Chrome UA, so issue search/create/update/comment
// all 403'd while GET calls (connect, /myself) passed. A non-browser UA is the
// reliable fix; X-Atlassian-Token: no-check is not honored for this case.
const JIRA_API_USER_AGENT = 'Orca'

export type JiraClientForSite = {
  site: JiraSite
  authorization: string
}

// Self-hosted Jira Server/Data Center only exposes REST v2; Cloud endpoints
// in this codebase are written against v3. Callers build paths with this
// prefix so one code path serves both deployments.
export function apiBasePath(site: JiraSite): string {
  return site.authType === 'server' ? '/rest/api/2' : '/rest/api/3'
}

export function apiBaseUrl(site: JiraSite): string {
  if (site.authType !== 'server' && site.apiBaseUrl !== undefined) {
    if (!isJiraGatewayBaseUrl(site.apiBaseUrl)) {
      throw new JiraApiError('Invalid Jira gateway URL. Reconnect this Jira site.')
    }
    return site.apiBaseUrl
  }
  return site.siteUrl
}

export function authHeader(email: string, apiToken: string, _authType?: JiraAuthType): string {
  // Self-hosted with no username = a personal access token (Bearer); Basic auth
  // with a PAT in the password slot is what produces the 401s users report.
  // Self-hosted WITH a username is classic username+password Basic auth, which
  // older Server/DC instances require. Email-free Cloud tokens use the gateway.
  if (!email) {
    return `Bearer ${apiToken}`
  }
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
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

export async function jiraFetch(url: string, init: RequestInit): Promise<Response> {
  return withSpan(
    'jira.request',
    async (span) => {
      span.setAttribute('jira.siteUrl', new URL(url).origin)
      const httpClient = getMainHttpClient()
      const proxySession = httpClient.proxySession()
      await ensureElectronProxyFromEnvironment({
        ...(proxySession ? { proxySession } : {}),
        probeUrl: url
      }).catch((error) => {
        span.addEvent('jira.proxySetupFailed', {
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
          'jira.transportErrorName',
          error instanceof Error ? error.name : typeof error
        )
        span.setAttribute(
          'jira.transportErrorMessage',
          error instanceof Error ? error.message : String(error)
        )
        const cause = describeErrorCause(error)
        if (cause) {
          span.setAttribute('jira.transportErrorCause', cause)
        }
        throw error
      }
    },
    { kind: 'client' }
  )
}

export async function requestWithCredentials(
  siteUrl: string,
  email: string,
  apiToken: string,
  path: string,
  init?: RequestInit,
  authType?: JiraAuthType
): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('User-Agent', JIRA_API_USER_AGENT)
  headers.set('Authorization', authHeader(email, apiToken, authType))
  const response = await jiraFetch(`${siteUrl}${path}`, {
    ...init,
    headers,
    ...(isJiraGatewayBaseUrl(siteUrl) ? { redirect: 'error' as const } : {})
  })
  if (!response.ok) {
    throw await toJiraApiError(response, `${siteUrl}${path}`)
  }
  if (response.status === 204) {
    return null
  }
  return response.json()
}

export async function jiraRequest<T>(
  client: JiraClientForSite,
  path: string,
  init?: RequestInit,
  maxResponseBytes?: number
): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('User-Agent', JIRA_API_USER_AGENT)
  headers.set('Authorization', client.authorization)
  const url = `${apiBaseUrl(client.site)}${path}`
  const response = await jiraFetch(url, {
    ...init,
    headers,
    ...(isJiraGatewayBaseUrl(apiBaseUrl(client.site)) ? { redirect: 'error' as const } : {})
  })
  if (!response.ok) {
    throw await toJiraApiError(response, url, maxResponseBytes)
  }
  if (response.status === 204) {
    return null as T
  }
  if (maxResponseBytes !== undefined) {
    return readFetchResponseJsonWithinLimit<T>(response, maxResponseBytes)
  }
  return (await response.json()) as T
}

function resolveBinaryRequestUrl(site: JiraSite, pathOrUrl: string): URL {
  const siteUrl = new URL(site.siteUrl)
  const baseUrl = apiBaseUrl(site)
  const requestUrl = /^https?:\/\//i.test(pathOrUrl)
    ? new URL(pathOrUrl)
    : new URL(`${site.siteUrl}${pathOrUrl}`)
  if (!requestUrl.username && !requestUrl.password) {
    if (baseUrl !== site.siteUrl && requestUrl.href.startsWith(`${baseUrl}/`)) {
      return requestUrl
    }
    if (requestUrl.origin === siteUrl.origin) {
      if (baseUrl === site.siteUrl) {
        return requestUrl
      }
      if (requestUrl.pathname.startsWith('/rest/')) {
        return new URL(`${baseUrl}${requestUrl.pathname}${requestUrl.search}`)
      }
      throw new JiraApiError('Scoped Jira attachments require a REST content URL.', null)
    }
  }
  // The gateway origin is shared by every tenant, so its full cloud-ID prefix must match.
  throw new JiraApiError('Jira attachment URL must use the configured site origin.', null)
}

export async function jiraRequestBinary(
  client: JiraClientForSite,
  pathOrUrl: string,
  options: { maxBytes?: number; signal?: AbortSignal } = {}
): Promise<{ data: ArrayBuffer; contentType: string }> {
  const requestUrl = resolveBinaryRequestUrl(client.site, pathOrUrl)
  const headers = new Headers()
  // Why: attachment content is binary; forcing JSON Accept/Content-Type can
  // break downloads and confuses some Atlassian edge responses.
  headers.set('Accept', '*/*')
  headers.set('User-Agent', JIRA_API_USER_AGENT)
  headers.set('Authorization', client.authorization)
  const response = await jiraFetch(requestUrl.toString(), {
    headers,
    signal: options.signal,
    ...(isJiraGatewayBaseUrl(apiBaseUrl(client.site)) ? { redirect: 'error' as const } : {})
  })
  if (!response.ok) {
    throw await toJiraApiError(response, requestUrl.toString())
  }
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  const bytes = await readFetchResponseBytesWithinLimit(
    response,
    options.maxBytes ?? 2 * 1024 * 1024
  )
  return {
    data: Uint8Array.from(bytes).buffer,
    contentType
  }
}
