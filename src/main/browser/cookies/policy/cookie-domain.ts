import { isIP } from 'node:net'
import { parse as parseDomain } from 'tldts'
import { normalizeCookieDomain } from './cookie-domain-normalization'

export { normalizeCookieDomain }

// Private suffixes keep tenants such as foo.github.io and bar.github.io in separate removal scopes.
export const PUBLIC_SUFFIX_OPTIONS = { allowPrivateDomains: true } as const

function isListedSuffix(parsed: { isIcann: boolean | null; isPrivate: boolean | null }): boolean {
  return parsed.isIcann === true || parsed.isPrivate === true
}

// Normalize before IP detection so alternate address spellings share the same removal family.
// Bare public suffixes name no family; preserving one would exempt all tenants.
export function registrableFamily(domain: string): string | null {
  const host = normalizeCookieDomain(domain)
  if (!host) {
    return null
  }
  if (isIP(host)) {
    return host
  }
  // isIP requires IPv6 addresses without brackets.
  if (host.startsWith('[') && host.endsWith(']') && isIP(host.slice(1, -1)) === 6) {
    return host
  }
  const parsed = parseDomain(host, PUBLIC_SUFFIX_OPTIONS)
  if (parsed.hostname === null) {
    return host
  }
  if (parsed.domain === null) {
    return isListedSuffix(parsed) ? null : host
  }
  return parsed.domain
}

export function normalizeCookieImportDomain(domain: string): string | null {
  const normalized = normalizeCookieDomain(domain)
  if (!normalized) {
    return null
  }
  const parsed = parseDomain(normalized, PUBLIC_SUFFIX_OPTIONS)
  if (parsed.hostname === null) {
    return normalized.startsWith('[') && normalized.endsWith(']') ? normalized : null
  }
  if (parsed.domain === null && isListedSuffix(parsed)) {
    return null
  }
  return normalized
}
