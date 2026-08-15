import type { PlaneViewer } from '../../shared/plane/types'
import type { PlaneClientForInstance } from './client'
import { writeToken } from './instance-storage'

export const PLANE_REQUEST_TIMEOUT_MS = 30_000
const OAUTH_EXPIRY_SKEW_MS = 60_000

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim())
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function instanceId(baseUrl: string, workspaceSlug: string): string {
  return `${normalizeBaseUrl(baseUrl)}::${workspaceSlug.trim()}`
}

export async function planeFetch<T>(
  client: PlaneClientForInstance,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const auth = await currentAuth(client)
  const timeoutSignal = AbortSignal.timeout(PLANE_REQUEST_TIMEOUT_MS)
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  if (auth.kind === 'oauth') {
    headers.set('Authorization', `Bearer ${auth.accessToken}`)
  } else {
    headers.set('X-API-Key', auth.apiKey)
  }
  const response = await fetch(`${client.instance.baseUrl}${path}`, {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal,
    headers
  })
  if (!response.ok) {
    throw new Error(`Plane API ${response.status}: ${await response.text()}`.slice(0, 300))
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

const inFlightRefresh = new Map<string, Promise<Awaited<ReturnType<typeof refreshOAuthToken>>>>()

async function currentAuth(
  client: PlaneClientForInstance
): Promise<PlaneClientForInstance['auth']> {
  if (client.auth.kind !== 'oauth' || !tokenExpiresSoon(client.auth.expiresAt)) {
    return client.auth
  }
  if (!client.auth.refreshToken || !client.auth.clientId || !client.auth.clientSecret) {
    throw new Error('Plane OAuth token expired. Reconnect Plane to continue.')
  }
  const id = client.instance.id
  let pending = inFlightRefresh.get(id)
  if (!pending) {
    pending = refreshOAuthToken(client).finally(() => inFlightRefresh.delete(id))
    inFlightRefresh.set(id, pending)
  }
  const token = await pending
  const auth = { kind: 'oauth' as const, ...token }
  client.auth = auth
  writeToken(id, JSON.stringify(token))
  return auth
}

function tokenExpiresSoon(expiresAt?: number): boolean {
  return typeof expiresAt === 'number' && expiresAt <= Date.now() + OAUTH_EXPIRY_SKEW_MS
}

async function refreshOAuthToken(client: PlaneClientForInstance): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt?: number
  clientId: string
  clientSecret: string
}> {
  if (client.auth.kind !== 'oauth' || !client.auth.refreshToken) {
    throw new Error('Plane OAuth token expired. Reconnect Plane to continue.')
  }
  const response = await fetch(new URL('/auth/o/token/', client.instance.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(PLANE_REQUEST_TIMEOUT_MS),
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: client.auth.refreshToken,
      client_id: client.auth.clientId,
      client_secret: client.auth.clientSecret
    })
  })
  if (!response.ok) {
    throw new Error(`Plane OAuth refresh failed: ${await response.text()}`.slice(0, 300))
  }
  const raw = (await response.json()) as Record<string, unknown>
  if (typeof raw.access_token !== 'string' || !raw.access_token) {
    throw new Error('Plane OAuth refresh response did not include an access token')
  }
  const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : null
  return {
    accessToken: raw.access_token,
    refreshToken:
      typeof raw.refresh_token === 'string' ? raw.refresh_token : client.auth.refreshToken,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    clientId: client.auth.clientId,
    clientSecret: client.auth.clientSecret
  }
}

export async function fetchPlaneViewer(client: PlaneClientForInstance): Promise<PlaneViewer> {
  const data = await planeFetch<Record<string, unknown>>(client, '/api/v1/users/me/')
  const id = stringField(data, 'id') ?? undefined
  const displayName =
    stringField(data, 'display_name') ?? stringField(data, 'first_name') ?? 'Plane user'
  return { id, displayName, email: stringField(data, 'email') }
}

export function apiPath(client: PlaneClientForInstance, suffix: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(client.instance.workspaceSlug)}${suffix}`
}

export function planeWebUrl(client: PlaneClientForInstance, identifier: string): string {
  return `${client.instance.baseUrl}/${client.instance.workspaceSlug}/issues/${identifier}`
}

function stringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
