import { normalizeCookieDomain } from './cookie-domain'

const GOOGLE_SOURCE_BOUND_COOKIE_NAMES = new Set([
  'SIDCC',
  '__Secure-1PSIDCC',
  '__Secure-3PSIDCC',
  '__Secure-STRP',
  'AEC'
])

// Preserve device-bound Google sessions; YouTube accepts imports and stays eligible.
// Entries must be canonical lowercase ASCII registrable domains, never public suffixes.
const NON_TRANSPLANTABLE_DOMAINS = ['google.com'] as const

export function isNonTransplantableCookieDomain(domain: string): boolean {
  const normalized = normalizeCookieDomain(domain)
  if (!normalized) {
    return false
  }
  return NON_TRANSPLANTABLE_DOMAINS.some(
    (root) => normalized === root || normalized.endsWith(`.${root}`)
  )
}

export function isGoogleSourceBoundCookie(name: string, domain: string): boolean {
  if (!GOOGLE_SOURCE_BOUND_COOKIE_NAMES.has(name)) {
    return false
  }
  const normalized = normalizeCookieDomain(domain)
  return normalized === 'google.com' || normalized?.endsWith('.google.com') === true
}
