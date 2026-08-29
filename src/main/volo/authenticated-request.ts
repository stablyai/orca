import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { getMainHttpClient } from '../network/http-client'
import { withSpan } from '../observability/tracer'

const VOLO_API_USER_AGENT = 'Orca'

export class VoloApiError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

export function isVoloAuthError(error: unknown): boolean {
  return error instanceof VoloApiError && (error.status === 401 || error.status === 403)
}

export function isVoloNotFoundError(error: unknown): boolean {
  return error instanceof VoloApiError && error.status === 404
}

type VoloEnvelope = {
  success?: boolean
  data?: unknown
  error?: string
  message?: string
}

async function voloFetch(url: string, init: RequestInit): Promise<Response> {
  return withSpan(
    'volo.request',
    async (span) => {
      span.setAttribute('volo.url', new URL(url).origin)
      const httpClient = getMainHttpClient()
      const proxySession = httpClient.proxySession()
      await ensureElectronProxyFromEnvironment({
        ...(proxySession ? { proxySession } : {}),
        probeUrl: url
      }).catch(() => {
        // Proxy setup is best-effort; the request still proceeds.
      })
      return httpClient.fetch(url, init)
    },
    { kind: 'client' }
  )
}

async function readVoloError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as VoloEnvelope
    return (
      data.message ||
      data.error ||
      response.statusText ||
      `Volo request failed (${response.status})`
    )
  } catch {
    return response.statusText || `Volo request failed (${response.status})`
  }
}

export async function voloRequest(
  apiUrl: string,
  token: string,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('User-Agent', VOLO_API_USER_AGENT)
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  const response = await voloFetch(`${apiUrl}${path}`, { ...init, headers })
  if (!response.ok) {
    throw new VoloApiError(await readVoloError(response), response.status)
  }
  if (response.status === 204) {
    return null
  }
  const payload = (await response.json()) as VoloEnvelope
  if (payload.success === false) {
    throw new VoloApiError(
      payload.message || payload.error || 'Volo request failed',
      response.status
    )
  }
  return payload.data !== undefined ? payload.data : payload
}

export async function refreshVoloAccessTokens(
  apiUrl: string,
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const payload = (await voloRequest(apiUrl, '', '/api/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken })
  })) as Record<string, unknown>
  const accessToken = typeof payload.accessToken === 'string' ? payload.accessToken.trim() : ''
  const nextRefresh = typeof payload.refreshToken === 'string' ? payload.refreshToken.trim() : ''
  const expiresIn =
    typeof payload.expiresIn === 'number' && Number.isFinite(payload.expiresIn)
      ? payload.expiresIn
      : 0
  if (!accessToken || !nextRefresh) {
    throw new VoloApiError('Volo did not return refreshed Google credentials.')
  }
  return { accessToken, refreshToken: nextRefresh, expiresIn }
}
