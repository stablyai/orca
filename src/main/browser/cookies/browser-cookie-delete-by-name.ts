import type { BrowserCookieDeleteResult } from '../../../shared/browser/runtime/runtime-browser-contracts'
import { BrowserError } from '../browser-error'
import type { CdpCommandSender } from '../cdp/debugger/cdp-command-sender'
import { cdpCookiesFromCommand } from './browser-cdp-cookie'
import { normalizeCookieDomain } from './policy/cookie-domain'

type CookieDeleteTarget = {
  domain?: string
  url?: string
  /** The tab's URL, used when neither `domain` nor `url` is given. */
  pageUrl: string
}

function cookieDeleteHost({ domain, url, pageUrl }: CookieDeleteTarget): string {
  if (domain) {
    const host = normalizeCookieDomain(domain)
    if (!host) {
      throw new BrowserError('invalid_argument', `Invalid cookie domain "${domain}"`)
    }
    return host
  }
  if (url) {
    const host = URL.parse(url)?.hostname
    if (!host) {
      throw new BrowserError('invalid_argument', `Invalid cookie URL "${url}"`)
    }
    return host
  }
  const page = URL.parse(pageUrl)
  if (!page?.hostname || (page.protocol !== 'http:' && page.protocol !== 'https:')) {
    throw new BrowserError(
      'invalid_argument',
      `The tab is on "${pageUrl}", which has no cookie domain; pass --domain or --url`
    )
  }
  return page.hostname
}

/**
 * Deletes cookies named `name` stored on `domain` (host-only or dot-prefixed), or else every cookie
 * of that name the `url` (or tab) host would receive, at any path. Network.deleteCookies alone
 * matches only the exact stored domain, which would leave `Domain=`-scoped cookies (stored as
 * `.example.com`).
 */
export async function deleteCookieByName(
  sender: CdpCommandSender,
  name: string,
  target: CookieDeleteTarget
): Promise<BrowserCookieDeleteResult> {
  const host = cookieDeleteHost(target)
  const matches = cdpCookiesFromCommand(await sender('Network.getAllCookies')).filter(
    ({ name: cookieName, domain: cookieDomain = '', partitionKeyOpaque }) =>
      cookieName === name &&
      // Opaque partition keys cannot be passed back to Network.deleteCookies.
      !partitionKeyOpaque &&
      (cookieDomain === host ||
        cookieDomain === `.${host}` ||
        (!target.domain && cookieDomain.startsWith('.') && host.endsWith(cookieDomain)))
  )
  await Promise.all(
    matches.map((cookie) =>
      sender('Network.deleteCookies', {
        name,
        domain: cookie.domain,
        path: cookie.path,
        // Partitioned (CHIPS) cookies are only deleted when their partition key is passed back.
        ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {})
      })
    )
  )
  return { deleted: matches.length > 0 }
}
