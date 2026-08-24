import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { getMainHttpClient } from '../network/http-client'
import { withSpan } from '../observability/tracer'
import type { ShortcutWorkspace } from '../../shared/shortcut-types'

export const SHORTCUT_API_BASE_URL = 'https://api.app.shortcut.com'

const SHORTCUT_API_USER_AGENT = 'Orca'

// Why: a hung request would otherwise hold one of the four shared queue slots
// indefinitely; callers' own abort signals still apply via AbortSignal.any.
const REQUEST_TIMEOUT_MS = 30_000

export type ShortcutClientForWorkspace = {
  workspace: ShortcutWorkspace
  token: string
}

export class ShortcutApiError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
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

async function shortcutFetch(url: string, init: RequestInit): Promise<Response> {
  return withSpan(
    'shortcut.request',
    async (span) => {
      span.setAttribute('shortcut.path', new URL(url).pathname)
      const httpClient = getMainHttpClient()
      const proxySession = httpClient.proxySession()
      await ensureElectronProxyFromEnvironment({
        ...(proxySession ? { proxySession } : {}),
        probeUrl: url
      }).catch((error) => {
        span.addEvent('shortcut.proxySetupFailed', {
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error)
        })
      })
      try {
        // Why: on the desktop this is Electron's net.fetch, which follows Chromium
        // proxy/session state and avoids undici's stale keep-alive sockets after
        // VPN path changes. A host without Chromium gets Node's fetch instead.
        return await httpClient.fetch(url, init)
      } catch (error) {
        span.setAttribute(
          'shortcut.transportErrorName',
          error instanceof Error ? error.name : typeof error
        )
        span.setAttribute(
          'shortcut.transportErrorMessage',
          error instanceof Error ? error.message : String(error)
        )
        const cause = describeErrorCause(error)
        if (cause) {
          span.setAttribute('shortcut.transportErrorCause', cause)
        }
        throw error
      }
    },
    { kind: 'client' }
  )
}

async function readShortcutError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as {
      message?: string
      errors?: Record<string, unknown>
    }
    const messages = [
      ...(data.message ? [data.message] : []),
      ...Object.entries(data.errors ?? {}).map(([key, value]) => `${key}: ${String(value)}`)
    ].filter(Boolean)
    if (messages.length > 0) {
      return messages.join('; ')
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `Shortcut request failed (${response.status})`
}

export async function requestWithToken(
  apiToken: string,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('User-Agent', SHORTCUT_API_USER_AGENT)
  headers.set('Shortcut-Token', apiToken)
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const response = await shortcutFetch(`${SHORTCUT_API_BASE_URL}${path}`, {
    ...init,
    headers,
    signal: init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal
  })
  if (!response.ok) {
    throw new ShortcutApiError(await readShortcutError(response), response.status)
  }
  if (response.status === 204) {
    return null
  }
  return response.json()
}

export async function shortcutRequest<T>(
  client: ShortcutClientForWorkspace,
  path: string,
  init?: RequestInit
): Promise<T> {
  return (await requestWithToken(client.token, path, init)) as T
}
