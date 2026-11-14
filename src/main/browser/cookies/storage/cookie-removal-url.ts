import type { Cookie } from 'electron'

// normalizedDomain must come from normalizeCookieDomain.
export function cookieRemovalUrl(cookie: Cookie, normalizedDomain: string): string {
  const url = new URL(`${cookie.secure ? 'https' : 'http'}://${normalizedDomain}/`)
  url.pathname = cookie.path?.startsWith('/') ? cookie.path : '/'
  return url.toString()
}
