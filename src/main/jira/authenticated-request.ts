import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { getMainHttpClient } from '../network/http-client'
import { withSpan } from '../observability/tracer'
import type { JiraAuthType, JiraSite } from '../../shared/jira-types'

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

// Scoped Cloud tokens are only honoured on the api.atlassian.com gateway, so
// REST calls go there while the site URL stays the browse/identity origin.
export function apiBaseUrl(site: JiraSite): string {
  return site.apiBaseUrl ?? site.siteUrl
}

export class JiraApiError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

export function authHeader(email: string, apiToken: string, authType?: JiraAuthType): string {
  // Self-hosted with no username = a personal access token (Bearer); Basic auth
  // with a PAT in the password slot is what produces the 401s users report.
  // Self-hosted WITH a username is classic username+password Basic auth, which
  // older Server/DC instances (predating PATs) require. Classic Cloud is always
  // Basic; a scoped Cloud token is Basic with the email and Bearer without.
  if ((authType === 'server' || authType === 'cloud-scoped') && !email) {
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
  baseUrl: string,
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
  const response = await jiraFetch(`${baseUrl}${path}`, {
    ...init,
    headers
  })
  if (!response.ok) {
    throw new JiraApiError(await readJiraError(response), response.status)
  }
  if (response.status === 204) {
    return null
  }
  return response.json()
}

async function readJiraError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as {
      errorMessages?: string[]
      errors?: Record<string, string>
      message?: string
    }
    const messages = [
      ...(Array.isArray(data.errorMessages) ? data.errorMessages : []),
      ...Object.values(data.errors ?? {}),
      ...(data.message ? [data.message] : [])
    ].filter(Boolean)
    if (messages.length > 0) {
      return messages.join('; ')
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `Jira request failed (${response.status})`
}

export async function jiraRequest<T>(
  client: JiraClientForSite,
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('User-Agent', JIRA_API_USER_AGENT)
  headers.set('Authorization', client.authorization)
  const response = await jiraFetch(`${apiBaseUrl(client.site)}${path}`, {
    ...init,
    headers
  })
  if (!response.ok) {
    throw new JiraApiError(await readJiraError(response), response.status)
  }
  if (response.status === 204) {
    return null as T
  }
  return (await response.json()) as T
}

// Why: attachment metadata is provider-controlled; never forward Jira
// credentials if a malformed response points at another origin. Cloud reports
// content URLs on the site host even when the token is only valid on the
// gateway, so those are re-rooted onto the gateway instead of rejected.
function resolveBinaryRequestUrl(site: JiraSite, pathOrUrl: string): URL {
  const siteUrl = new URL(site.siteUrl)
  const requestUrl = /^https?:\/\//i.test(pathOrUrl)
    ? new URL(pathOrUrl)
    : new URL(`${site.siteUrl}${pathOrUrl}`)
  if (site.apiBaseUrl) {
    if (requestUrl.origin === new URL(site.apiBaseUrl).origin) {
      return requestUrl
    }
    if (requestUrl.origin === siteUrl.origin) {
      return new URL(`${site.apiBaseUrl}${requestUrl.pathname}${requestUrl.search}`)
    }
  } else if (requestUrl.origin === siteUrl.origin) {
    return requestUrl
  }
  throw new JiraApiError('Jira attachment URL must use the configured site origin.', null)
}

export async function jiraRequestBinary(
  client: JiraClientForSite,
  pathOrUrl: string
): Promise<{ data: ArrayBuffer; contentType: string }> {
  const requestUrl = resolveBinaryRequestUrl(client.site, pathOrUrl)
  const headers = new Headers()
  // Why: attachment content is binary; forcing JSON Accept/Content-Type can
  // break downloads and confuses some Atlassian edge responses.
  headers.set('Accept', '*/*')
  headers.set('User-Agent', JIRA_API_USER_AGENT)
  headers.set('Authorization', client.authorization)
  const response = await jiraFetch(requestUrl.toString(), { headers })
  if (!response.ok) {
    throw new JiraApiError(await readJiraError(response), response.status)
  }
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  return {
    data: await response.arrayBuffer(),
    contentType
  }
}
