import { isIP } from 'node:net'
import type { Cookie, Cookies } from 'electron'
import { parse as parseDomain } from 'psl'
// Why: type-only, so this does not create a runtime cycle with the clear module.
import type { CookieClearIdentity } from './browser-cookie-import-clear'

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

// Why (STA-4300): one definition of "family" for every consumer of the partition skip set — the
// planner, the per-coordinate removal filter, and the path A domain comparison. Deriving it inline
// in several places is what let the removal scope and the write set disagree (STA-4090, STA-4170).
//
// The IP test MUST run on normalizeCookieDomain's output, never the raw string: Chromium accepts
// many spellings of one address and psl mangles all of them (psl.parse('2130706433').domain is
// null, psl.parse('127.0.0.1').domain is '0.1'). normalizeCookieDomain runs the value through
// `new URL()`, which canonicalises 127.1 / 2130706433 / 0x7f.1 / 010.0.0.1 / a trailing dot to a
// dotted quad first, so isIP() then recognises every one of them.
//
// Returns null when no family can be named (a bare public suffix). A helper that named `com` as a
// family would preserve an entire TLD from removal, silently turning an import into a no-op.
export function registrableFamily(domain: string): string | null {
  const host = normalizeCookieDomain(domain)
  if (!host) {
    return null
  }
  if (isIP(host)) {
    return host
  }
  // Why: isIP('[::1]') is 0 — the brackets have to come off before the check.
  if (host.startsWith('[') && host.endsWith(']') && isIP(host.slice(1, -1)) === 6) {
    return host
  }
  const parsed = parseDomain(host)
  if ('error' in parsed) {
    return host
  }
  if (parsed.domain === null) {
    return parsed.listed ? null : host
  }
  return parsed.domain
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
// public suffixes: isNonTransplantableCookieDomain exempts an entry and everything under it, and
// the staged image's clear matches the same way. Adding a site is one entry here.
// youtube.com is deliberately NOT listed: YouTube accepts a transplanted session and re-issues
// its cookies via the accounts.youtube.com relay, so excluding it would silently drop imports
// users actually asked for.
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

// Why (STA-4797): one scope object, shared by every clear that precedes an import — path B's
// replacement, the native path's live-jar clear, and the staged image's delete. Each one used to
// name its own scope (or, on the native path, none at all), which is how the two import paths came
// to disagree about what an import is allowed to destroy.
export type ImportedDomainScope = {
  exact: Set<string>
  ancestors: Set<string>
  descendantRoots: Set<string>
}

export function importedDomainScope(domains: readonly string[]): ImportedDomainScope {
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

// Why: hostOnly is passed rather than read off a Cookie because the staged image scopes the same
// way from a raw Chromium host_key, where the leading dot is the only host-only marker there is.
export function domainIsInImportedScope(
  scope: ImportedDomainScope,
  domain: string,
  hostOnly: boolean
): boolean {
  if (scope.exact.has(domain)) {
    return true
  }
  if (!hostOnly && scope.ancestors.has(domain)) {
    return true
  }
  return domainSuffixes(domain).some((suffix) => scope.descendantRoots.has(suffix))
}

// Why: takes a normalizeCookieDomain output, never a raw cookie domain. That host already parsed
// as a URL hostname, and assigning pathname cannot throw, so this always builds — both callers
// used to carry a branch for a null that could not happen, one of them a throw that failed an
// import for a reason it could never actually hit.
export function cookieRemovalUrl(cookie: Cookie, normalizedDomain: string): string {
  const url = new URL(`${cookie.secure ? 'https' : 'http'}://${normalizedDomain}/`)
  url.pathname = cookie.path?.startsWith('/') ? cookie.path : '/'
  return url.toString()
}

// Why (STA-4097): 'set' stays out so the partition-dropping reconstruction cannot return.
// Undoing a removal is only possible through CDP identities, which carry partitionKey.
export type ImportedDomainReplaceStore = Pick<Cookies, 'get' | 'remove'> & {
  snapshotClearIdentities(
    cookies: readonly { cookie: Cookie; url: string }[]
  ): Promise<CookieClearIdentity[]>
  restoreClearIdentities(identities: readonly CookieClearIdentity[]): Promise<void>
}

export type ReplacedImportedDomainCookies = {
  removed: Cookie[]
  identities: CookieClearIdentity[]
}

function replaceRemovalKey(url: string, name: string): string {
  return JSON.stringify([url, name])
}

function assertIdentitiesCoverRemovable(
  removable: readonly { cookie: Cookie; url: string }[],
  identities: readonly CookieClearIdentity[]
): void {
  const covered = new Set(
    identities.map((identity) => replaceRemovalKey(identity.url, identity.name))
  )
  for (const item of removable) {
    if (!covered.has(replaceRemovalKey(item.url, item.cookie.name))) {
      throw new Error('Could not replace existing cookies; the session was left unchanged')
    }
  }
}

export async function replaceCookiesForImportedDomains(
  store: ImportedDomainReplaceStore,
  importedDomains: readonly string[]
): Promise<ReplacedImportedDomainCookies> {
  const scope = importedDomainScope(importedDomains)
  if (scope.exact.size === 0) {
    return { removed: [], identities: [] }
  }

  // Why (STA-4170): the removal plan is fixed here, beside the identities that can undo it, so
  // the restorable set always equals the mutated set. Re-reading the jar later would widen the
  // removal past what the snapshot can restore.
  const existingCookies = await store.get({})
  const removable: { cookie: Cookie; url: string }[] = []
  for (const cookie of existingCookies) {
    const domain = cookie.domain ? normalizeCookieDomain(cookie.domain) : null
    if (!domain || !domainIsInImportedScope(scope, domain, cookie.hostOnly === true)) {
      continue
    }
    removable.push({ cookie, url: cookieRemovalUrl(cookie, domain) })
  }
  if (removable.length === 0) {
    return { removed: [], identities: [] }
  }

  // Why: snapshotting before the first removal is what makes the rollback lossless; an
  // incomplete snapshot aborts while the session is still untouched.
  const identities = await store.snapshotClearIdentities(removable)
  assertIdentitiesCoverRemovable(removable, identities)
  const identitiesByKey = new Map<string, CookieClearIdentity[]>()
  for (const identity of identities) {
    const key = replaceRemovalKey(identity.url, identity.name)
    const group = identitiesByKey.get(key) ?? []
    group.push(identity)
    identitiesByKey.set(key, group)
  }

  const removed: Cookie[] = []
  // Why: one remove(url, name) deletes every cookie at that coordinate, partitioned twins
  // included, so the rollback set is tracked per coordinate rather than per cookie.
  const attemptedKeys = new Set<string>()
  const attemptedIdentities: CookieClearIdentity[] = []
  for (const { cookie, url } of removable) {
    const key = replaceRemovalKey(url, cookie.name)
    if (!attemptedKeys.has(key)) {
      attemptedKeys.add(key)
      attemptedIdentities.push(...(identitiesByKey.get(key) ?? []))
    }
    try {
      await store.remove(url, cookie.name)
      removed.push(cookie)
    } catch (err) {
      try {
        // Why: the failing coordinate is included because a rejected remove cannot prove the
        // cookie survived; restoring a live cookie rewrites the value it was snapshotted with.
        await store.restoreClearIdentities(attemptedIdentities.toReversed())
      } catch (restoreError) {
        throw new AggregateError([err, restoreError], 'Cookie replacement and rollback failed')
      }
      throw err
    }
  }
  return { removed, identities }
}
