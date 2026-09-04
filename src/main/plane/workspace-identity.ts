import { createHash } from 'node:crypto'
import type { PlaneDeployment, PlaneViewer, PlaneWorkspace } from '../../shared/plane-types'

const PLANE_CLOUD_HOST = 'plane.so'
const CLOUD_API_ORIGIN = 'https://api.plane.so'
const CLOUD_APP_ORIGIN = 'https://app.plane.so'

/**
 * Accepts what people actually paste: a bare host, a trailing slash, or a url
 * with the `/api/v1` prefix already appended.
 */
export function normalizePlaneBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withProtocol)
  // Why: the API token travels in an X-API-Key header on every request. Any
  // other scheme would either send it in the clear through a non-TLS transport
  // or hand an arbitrary origin to net.fetch, and plane.connect is reachable
  // from a paired remote client.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Plane URL must use http or https.')
  }
  // Why: the normalized url is persisted in plane-workspaces.json and handed
  // back by status to any renderer or paired client. A password embedded here
  // would escape the boundary that keeps the PAT in the encrypted vault.
  if (url.username || url.password) {
    throw new Error('Plane URL must not contain a username or password.')
  }
  url.pathname = url.pathname.replace(/\/api\/v1\/?$/, '').replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function detectPlaneDeployment(baseUrl: string): PlaneDeployment {
  const host = safeHostname(baseUrl)
  return host === PLANE_CLOUD_HOST || host.endsWith(`.${PLANE_CLOUD_HOST}`)
    ? 'cloud'
    : 'self-hosted'
}

/**
 * Plane Cloud splits the REST API and the web app across two hosts; a
 * self-hosted instance serves both from one origin.
 */
export function defaultPlaneAppUrl(baseUrl: string): string {
  const normalized = normalizePlaneBaseUrl(baseUrl)
  if (detectPlaneDeployment(normalized) !== 'cloud') {
    return normalized
  }
  return normalized === CLOUD_API_ORIGIN ? CLOUD_APP_ORIGIN : normalized
}

/** Stable local id for a (base url, workspace slug) pair. */
export function getPlaneWorkspaceId(baseUrl: string, slug: string): string {
  return createHash('sha256')
    .update(`${normalizePlaneBaseUrl(baseUrl)}\n${slug.trim().toLowerCase()}`)
    .digest('base64url')
    .slice(0, 24)
}

export function buildPlaneWorkspace(input: {
  baseUrl: string
  slug: string
  name?: string
  appUrl?: string
}): PlaneWorkspace {
  const baseUrl = normalizePlaneBaseUrl(input.baseUrl)
  const slug = input.slug.trim()
  return {
    id: getPlaneWorkspaceId(baseUrl, slug),
    slug,
    name: input.name?.trim() || slug,
    baseUrl,
    appUrl: input.appUrl ? normalizePlaneBaseUrl(input.appUrl) : defaultPlaneAppUrl(baseUrl),
    deployment: detectPlaneDeployment(baseUrl)
  }
}

/** Maps the `/users/me/` payload; field names differ across Plane versions. */
export function toPlaneViewer(data: Record<string, unknown>): PlaneViewer {
  const first = readString(data.first_name)
  const last = readString(data.last_name)
  const email = readString(data.email)
  // `|| undefined` because join() yields '' for an empty name, and '' is not
  // nullish -- it would swallow the email fallback below.
  const fullName = [first, last].filter(Boolean).join(' ') || undefined
  const avatarUrl = readString(data.avatar_url) ?? readString(data.avatar)
  return {
    id: readString(data.id) ?? '',
    displayName: readString(data.display_name) ?? fullName ?? email ?? '',
    email: email ?? null,
    ...(avatarUrl ? { avatarUrl } : {})
  }
}

export function planeWorkspaceToViewer(workspace: PlaneWorkspace | null): PlaneViewer | null {
  if (!workspace) {
    return null
  }
  return { id: workspace.id, displayName: workspace.name, email: null }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function safeHostname(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ''
  }
}
