import type { PlaneViewer } from '../../shared/plane/types'
import type { PlaneClientForInstance } from './client'

const PLANE_REQUEST_TIMEOUT_MS = 30_000

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
  const timeoutSignal = AbortSignal.timeout(PLANE_REQUEST_TIMEOUT_MS)
  const authHeader: Record<string, string> =
    client.auth.kind === 'oauth'
      ? { Authorization: `Bearer ${client.auth.accessToken}` }
      : { 'X-API-Key': client.auth.apiKey }
  const response = await fetch(`${client.instance.baseUrl}${path}`, {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...authHeader,
      ...(init.headers as Record<string, string> | undefined)
    }
  })
  if (!response.ok) {
    throw new Error(`Plane API ${response.status}: ${await response.text()}`.slice(0, 300))
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
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
