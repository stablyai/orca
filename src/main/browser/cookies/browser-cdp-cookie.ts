/** A cookie as CDP's Network domain reports it: unlike `cookies.get()`, with its partition key. */
export type CdpCookiePartitionKey = {
  topLevelSite?: string
  hasCrossSiteAncestor?: boolean
}

export type CdpCookie = {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  session?: boolean
  expires?: number
  sameSite?: string
  partitionKey?: CdpCookiePartitionKey | null
  partitionKeyOpaque?: boolean
}

/** Reads the `cookies` array from a `Network.getAllCookies` reply. */
export function cdpCookiesFromCommand(value: unknown): CdpCookie[] {
  if (typeof value !== 'object' || value === null || !('cookies' in value)) {
    return []
  }
  const cookies = value.cookies
  return Array.isArray(cookies) ? cookies : []
}

function isOptional(value: unknown, type: 'string' | 'boolean' | 'number'): boolean {
  return value === undefined || typeof value === type
}

/** The fields a saved or copied cookie depends on: its identity, value and session class. */
function isCdpCookie(value: unknown): value is CdpCookie {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const cookie: Record<string, unknown> = { ...value }
  const partitionKey = cookie.partitionKey
  return (
    typeof cookie.name === 'string' &&
    typeof cookie.value === 'string' &&
    typeof cookie.session === 'boolean' &&
    isOptional(cookie.domain, 'string') &&
    isOptional(cookie.path, 'string') &&
    isOptional(cookie.secure, 'boolean') &&
    isOptional(cookie.httpOnly, 'boolean') &&
    isOptional(cookie.expires, 'number') &&
    isOptional(cookie.partitionKeyOpaque, 'boolean') &&
    (partitionKey === undefined || partitionKey === null || typeof partitionKey === 'object')
  )
}

/**
 * For a read whose result is persisted or copied: a reply without a `cookies` array, or with any
 * row missing a field the save or copy depends on, must never pass as an empty (or smaller) jar.
 */
export function requireCdpCookies(value: unknown): CdpCookie[] {
  const cookies =
    typeof value === 'object' && value !== null && 'cookies' in value ? value.cookies : null
  if (!Array.isArray(cookies) || !cookies.every(isCdpCookie)) {
    throw new Error('cdp_cookies_reply_invalid')
  }
  return cookies
}
