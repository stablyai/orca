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

function isCdpCookie(value: unknown): value is CdpCookie {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'value' in value &&
    typeof value.value === 'string'
  )
}

/**
 * For a read whose result is persisted: a reply without a `cookies` array, or with anything in it
 * that isn't a cookie, must never pass as an empty (or smaller) jar.
 */
export function requireCdpCookies(value: unknown): CdpCookie[] {
  const cookies =
    typeof value === 'object' && value !== null && 'cookies' in value ? value.cookies : null
  if (!Array.isArray(cookies) || !cookies.every(isCdpCookie)) {
    throw new Error('cdp_cookies_reply_invalid')
  }
  return cookies
}
