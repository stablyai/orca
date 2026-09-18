import { createHash } from 'node:crypto'
import type { MantisBTSite, MantisBTViewer } from '../../shared/mantisbt-types'
import { asRecord } from './mantisbt-record-pages'

const LOOPBACK_HOSTNAMES: Record<string, true> = { localhost: true, '127.0.0.1': true, '::1': true }

export function normalizeMantisBTSiteUrl(siteUrl: string): string {
  const trimmed = siteUrl.trim()
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withProtocol)
  // Why: the API token goes out as a bearer header on every request (CWE-319);
  // only a loopback host is exempted, for local development against a
  // MantisBT instance run on the same machine.
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && LOOPBACK_HOSTNAMES[url.hostname])
  ) {
    throw new Error('Enter an HTTPS MantisBT site URL (HTTP is only allowed for localhost).')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function getSiteId(siteUrl: string, userId: string): string {
  return createHash('sha256').update(`${siteUrl}\n${userId}`).digest('base64url').slice(0, 24)
}

// Why: `GET /api/rest/users/me` returns a flat user object (MantisBT's
// rest_user_get_me calls UserGetCommand with `return_as_users: false`) — the
// `user`/`users` envelope only wraps responses from `/users/{id}` and
// `/users/username/{username}`. Accept all three shapes defensively so a
// caller that reuses this helper for another endpoint (or a deployment that
// deviates from stock MantisBT) still resolves correctly.
function extractMantisBTUser(data: Record<string, unknown>): Record<string, unknown> {
  if (data.user && typeof data.user === 'object') {
    return asRecord(data.user)
  }
  const users = data.users
  if (Array.isArray(users) && users.length > 0) {
    return asRecord(users[0])
  }
  return data
}

export function toViewer(data: unknown): MantisBTViewer {
  const user = extractMantisBTUser(asRecord(data))
  const id =
    typeof user.id === 'number' ? String(user.id) : typeof user.id === 'string' ? user.id : ''
  const username =
    typeof user.name === 'string'
      ? user.name
      : typeof user.username === 'string'
        ? user.username
        : ''
  const realName = typeof user.real_name === 'string' ? user.real_name : ''
  return {
    id,
    displayName: realName || username || id,
    email: typeof user.email === 'string' ? user.email : undefined
  }
}

export function siteToViewer(site: MantisBTSite | null): MantisBTViewer | null {
  if (!site) {
    return null
  }
  return {
    id: site.userId,
    displayName: site.displayName
  }
}
