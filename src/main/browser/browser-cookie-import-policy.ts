import type { Cookie, Cookies, Session } from 'electron'
import { parse as parseDomain } from 'psl'
import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'

const GOOGLE_SOURCE_BOUND_COOKIE_NAMES = new Set([
  'SIDCC',
  '__Secure-1PSIDCC',
  '__Secure-3PSIDCC',
  '__Secure-STRP',
  'AEC'
])

export type CookieImportMode = 'merge' | 'replace-imported-domains'

export function normalizeCookieDomain(domain: string): string | null {
  const candidate = domain.trim().replace(/^\.+/, '')
  const isBracketedIpv6 = candidate.startsWith('[') && candidate.endsWith(']')
  if (!candidate || /[/\\@?#%]/.test(candidate) || (!isBracketedIpv6 && candidate.includes(':'))) {
    return null
  }
  try {
    const parsed = new URL(`https://${candidate}/`)
    const normalized = parsed.hostname.toLowerCase()
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      normalized.endsWith('.') ||
      normalized.includes('..')
    ) {
      return null
    }
    return normalized
  } catch {
    return null
  }
}

export function normalizeCookieImportDomain(domain: string): string | null {
  const normalized = normalizeCookieDomain(domain)
  if (!normalized) {
    return null
  }
  const parsed = parseDomain(normalized)
  if ('error' in parsed) {
    return normalized.startsWith('[') && normalized.endsWith(']') ? normalized : null
  }
  if (parsed.domain === null && parsed.listed) {
    return null
  }
  return normalized
}

// Why (STA-3811): registrable families whose sessions are device-bound server-side, so a
// transplanted cookie is rejected (or flagged and expired within ~1h) no matter how faithfully
// it is copied. Signing in directly inside Orca is the only path that produces a working
// session, so an import must never write these cookies and never remove them either — the
// live session is always more valuable than anything an import could put in its place.
// Entries must be canonical lowercase ASCII (punycode) registrable domains, never subdomains or
// public suffixes, because clearData derives one excluded origin and matches at that boundary.
// Adding a site is one entry here.
// youtube.com is deliberately NOT listed: YouTube accepts a transplanted session and re-issues
// its cookies via the accounts.youtube.com relay, so excluding it would silently drop imports
// users actually asked for.
const NON_TRANSPLANTABLE_DOMAINS = ['google.com'] as const
const NON_TRANSPLANTABLE_CLEAR_EXCLUDED_ORIGINS = NON_TRANSPLANTABLE_DOMAINS.map(
  (root) => `https://${root}`
)
const COOKIE_CLEAR_CONCURRENCY = 8

export function isNonTransplantableCookieDomain(domain: string): boolean {
  const normalized = normalizeCookieDomain(domain)
  if (!normalized) {
    return false
  }
  return NON_TRANSPLANTABLE_DOMAINS.some(
    (root) => normalized === root || normalized.endsWith(`.${root}`)
  )
}

// Why: Chromium stores host_key lowercase as 'google.com', '.google.com' or 'sub.google.com';
// the LIKE pattern covers the leading-dot row and cannot match lookalikes ('withgoogle.com').
export const NON_TRANSPLANTABLE_HOST_KEY_SQL = NON_TRANSPLANTABLE_DOMAINS.map(
  (root) => `host_key = '${root}' OR host_key LIKE '%.${root}'`
).join(' OR ')

// Why: subsumed by the domain exclusion above for google.com — kept because it is the general
// rule for rotation-only cookies and applies to any family added without a full exclusion.
export function isGoogleSourceBoundCookie(name: string, domain: string): boolean {
  if (!GOOGLE_SOURCE_BOUND_COOKIE_NAMES.has(name)) {
    return false
  }
  const normalized = normalizeCookieDomain(domain)
  return normalized === 'google.com' || normalized?.endsWith('.google.com') === true
}

function domainSuffixes(domain: string): string[] {
  const labels = domain.split('.')
  return labels.map((_, index) => labels.slice(index).join('.'))
}

function importDomainAncestors(domain: string): string[] {
  const parsed = parseDomain(domain)
  const boundary = 'error' in parsed ? domain : (parsed.domain ?? domain)
  const ancestors: string[] = []
  for (const suffix of domainSuffixes(domain)) {
    ancestors.push(suffix)
    if (suffix === boundary) {
      break
    }
  }
  return ancestors
}

function importedDomainScopes(domains: readonly string[]): {
  exact: Set<string>
  ancestors: Set<string>
  descendantRoots: Set<string>
} {
  const exact = new Set<string>()
  const ancestors = new Set<string>()
  const descendantRoots = new Set<string>()
  const seen = new Set<string>()
  for (const domain of domains) {
    const candidate = normalizeCookieDomain(domain)
    if (!candidate || seen.has(candidate)) {
      continue
    }
    seen.add(candidate)
    const normalized = normalizeCookieImportDomain(candidate)
    if (!normalized || exact.has(normalized)) {
      continue
    }
    exact.add(normalized)
    if (normalized.includes('.')) {
      descendantRoots.add(normalized)
    }
    for (const suffix of importDomainAncestors(normalized)) {
      ancestors.add(suffix)
    }
  }
  return { exact, ancestors, descendantRoots }
}

function overlapsImportedDomain(
  cookie: Cookie,
  domain: string,
  scopes: ReturnType<typeof importedDomainScopes>
): boolean {
  if (scopes.exact.has(domain)) {
    return true
  }
  if (cookie.hostOnly !== true && scopes.ancestors.has(domain)) {
    return true
  }
  return domainSuffixes(domain).some((suffix) => scopes.descendantRoots.has(suffix))
}

function cookieRemovalUrl(cookie: Cookie, domain: string): string | null {
  try {
    const url = new URL(`${cookie.secure ? 'https' : 'http'}://${domain}/`)
    url.pathname = cookie.path?.startsWith('/') ? cookie.path : '/'
    return url.toString()
  } catch {
    return null
  }
}

export async function restoreImportedDomainCookies(
  store: Pick<Cookies, 'set'>,
  cookies: readonly Cookie[]
): Promise<void> {
  const failures: unknown[] = []
  for (const cookie of cookies) {
    try {
      const domain = cookie.domain ? normalizeCookieDomain(cookie.domain) : null
      const url = domain ? cookieRemovalUrl(cookie, domain) : null
      if (!url) {
        continue
      }
      await store.set({
        url,
        name: cookie.name,
        value: cookie.value,
        ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
        ...(cookie.path ? { path: cookie.path } : {}),
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {})
      })
    } catch (err) {
      failures.push(err)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Could not restore replaced cookies')
  }
}

// Why (STA-4061): 'set' stays out so the lossy partition-dropping reconstruction cannot return.
export type CookieClearSession = {
  cookies: Pick<Cookies, 'get' | 'remove'>
  clearData: Session['clearData']
}

// Why: Electron cannot round-trip partition identity, so excluded cookies must never be removed.
// Why (STA-4061): the same gap forbids rolling a partial clear back. cookies.get() omits
// partitionKey and cookies.set() silently drops it, so every reconstruction is a coin flip that
// can downgrade a partitioned (CHIPS) cookie into an unpartitioned one — and nothing in the
// snapshot says which cookies are at risk. A partially cleared jar is a retryable import failure;
// a downgraded cookie is unrecoverable auth-state corruption that survives restart.
// Why (STA-4065): the exclusion is module state rather than a parameter so the predicate and the
// origins the bulk clear preserves cannot drift apart — a caller-supplied predicate that disagreed
// with NON_TRANSPLANTABLE_DOMAINS would silently delete a cookie the bulk call is meant to keep.
export async function removeTransplantableCookies(
  targetSession: CookieClearSession
): Promise<void> {
  const store = targetSession.cookies
  const initialCookies = await store.get({})
  if (initialCookies.length === 0) {
    return
  }

  // Why (STA-4065): measured on Electron 43, excludeOrigins preserves the whole registrable
  // family — host, leading-dot, subdomain, and partitioned Google cookies — so one call replaces a
  // remove() per cookie even when the jar holds cookies to keep. That is the ordinary case here:
  // this import exists for Google, so a Google cookie is usually present.
  try {
    await targetSession.clearData({
      dataTypes: ['cookies'],
      excludeOrigins: NON_TRANSPLANTABLE_CLEAR_EXCLUDED_ORIGINS
    })
    return
  } catch {
    // Why: a rejected bulk clear can still have changed the jar, so the fallback must act on the
    // survivors rather than stale removal coordinates from before the attempt.
  }

  const existingCookies = await store.get({})
  const removableGroups = new Map<string, { cookie: Cookie; url: string }[]>()
  for (const cookie of existingCookies) {
    if (isNonTransplantableCookieDomain(cookie.domain ?? '')) {
      continue
    }
    const domain = cookie.domain ? normalizeCookieDomain(cookie.domain) : null
    const url = domain ? cookieRemovalUrl(cookie, domain) : null
    if (!url) {
      continue
    }
    const key = JSON.stringify([url, cookie.name])
    const group = removableGroups.get(key) ?? []
    group.push({ cookie, url })
    removableGroups.set(key, group)
  }

  const results = await mapSettledWithConcurrency(
    [...removableGroups.values()],
    COOKIE_CLEAR_CONCURRENCY,
    async (group) => {
      // Why: identical removal coordinates must stay ordered instead of racing.
      for (const { cookie, url } of group) {
        await store.remove(url, cookie.name)
      }
    }
  )
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'Could not clear existing cookies; the session was left partially cleared'
    )
  }
}

export async function replaceCookiesForImportedDomains(
  store: Pick<Cookies, 'get' | 'remove' | 'set'>,
  importedDomains: readonly string[]
): Promise<Cookie[]> {
  const scopes = importedDomainScopes(importedDomains)
  if (scopes.exact.size === 0) {
    return []
  }

  const existingCookies = await store.get({})
  const removedCookies: Cookie[] = []
  for (const cookie of existingCookies) {
    const domain = cookie.domain ? normalizeCookieDomain(cookie.domain) : null
    if (!domain || !overlapsImportedDomain(cookie, domain, scopes)) {
      continue
    }
    const url = cookieRemovalUrl(cookie, domain)
    if (!url) {
      continue
    }
    try {
      await store.remove(url, cookie.name)
      removedCookies.push(cookie)
    } catch (err) {
      try {
        await restoreImportedDomainCookies(store, removedCookies)
      } catch (restoreError) {
        throw new AggregateError([err, restoreError], 'Cookie replacement and rollback failed')
      }
      throw err
    }
  }
  return removedCookies
}
