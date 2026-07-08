import { net, session } from 'electron'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { withSpan } from '../observability/tracer'
import type { JiraSite } from '../../shared/types'

// Why: Atlassian's XSRF filter rejects POST/PUT REST calls that carry a browser
// User-Agent, failing them with "XSRF check failed" even under API-token auth.
// Electron's net.fetch sends a Chrome UA, so issue search/create/update/comment
// all 403'd while GET calls (connect, /myself) passed. A non-browser UA is the
// reliable fix; X-Atlassian-Token: no-check is not honored for this case.
const JIRA_API_USER_AGENT = 'Orca'
export const JIRA_REQUEST_TIMEOUT_MS = 30_000
const JIRA_REQUEST_TIMEOUT_MESSAGE = 'Jira request timed out.'
export const JIRA_HTTPS_REQUIRED_MESSAGE = 'Jira sites must use HTTPS to send credentials.'

export type JiraClientForSite = {
  site: JiraSite
  authorization: string
}

export class JiraApiError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

function getJiraErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return null
  }
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' && Number.isFinite(status) ? status : null
}

export function toJiraErrorWithStatus(error: unknown): unknown {
  const status = getJiraErrorStatus(error)
  if (
    status === null ||
    !(error instanceof Error) ||
    error.message.startsWith(`Error ${status}:`)
  ) {
    return error
  }
  return new Error(`Error ${status}: ${error.message}`)
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

function createJiraRequestTimeoutError(): JiraApiError {
  return new JiraApiError(JIRA_REQUEST_TIMEOUT_MESSAGE, null)
}

function assertHttpsJiraSiteUrl(siteUrl: string): void {
  if (new URL(siteUrl).protocol !== 'https:') {
    throw new JiraApiError(JIRA_HTTPS_REQUIRED_MESSAGE, null)
  }
}

async function jiraFetch(url: string, init: RequestInit): Promise<Response> {
  return withSpan(
    'jira.request',
    async (span) => {
      span.setAttribute('jira.siteUrl', new URL(url).origin)
      const controller = new AbortController()
      const callerSignal = init.signal ?? undefined
      const abortFromCaller = (): void => {
        controller.abort(callerSignal?.reason)
      }
      if (callerSignal?.aborted) {
        abortFromCaller()
      } else {
        callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
      }
      let timedOut = false
      let timeoutError: JiraApiError | null = null
      let timeout: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true
          timeoutError = createJiraRequestTimeoutError()
          reject(timeoutError)
          controller.abort(timeoutError)
        }, JIRA_REQUEST_TIMEOUT_MS)
      })
      try {
        await Promise.race([
          ensureElectronProxyFromEnvironment({
            proxySession: session.defaultSession,
            probeUrl: url
          }).catch((error) => {
            span.addEvent('jira.proxySetupFailed', {
              errorName: error instanceof Error ? error.name : typeof error,
              errorMessage: error instanceof Error ? error.message : String(error)
            })
          }),
          timeoutPromise
        ])
        // Why: Electron's network stack follows Chromium proxy/session state,
        // avoiding undici's stale keep-alive sockets after VPN path changes.
        return await Promise.race([
          net.fetch(url, { ...init, signal: controller.signal }),
          timeoutPromise
        ])
      } catch (error) {
        if (timedOut) {
          throw timeoutError ?? createJiraRequestTimeoutError()
        }
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
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout)
        }
        callerSignal?.removeEventListener('abort', abortFromCaller)
      }
    },
    { kind: 'client' }
  )
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

async function readJiraJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    // Why: private Server/DC deployments often answer auth mismatches with an
    // HTML login page; callers should see a sanitized Jira-mode/auth error.
    throw new JiraApiError(
      'Jira returned a non-JSON response. Check the selected deployment type and credentials.',
      response.status
    )
  }
}

export async function jiraRequestWithAuthorization(
  siteUrl: string,
  authorization: string,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  assertHttpsJiraSiteUrl(siteUrl)
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('User-Agent', JIRA_API_USER_AGENT)
  headers.set('Authorization', authorization)
  const response = await jiraFetch(`${siteUrl}${path}`, {
    ...init,
    headers
  })
  if (!response.ok) {
    throw new JiraApiError(await readJiraError(response), response.status)
  }
  if (response.status === 204) {
    return null
  }
  return readJiraJson(response)
}

export async function jiraRequest<T>(
  client: JiraClientForSite,
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await jiraRequestWithAuthorization(
    client.site.siteUrl,
    client.authorization,
    path,
    init
  )
  return response as T
}
