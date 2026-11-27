/** Scope bookkeeping for saved session cookies: what changed, and what Electron's cookie list can settle. */
import type { Cookie } from 'electron'
import type { CdpCookie } from '../browser-cdp-cookie'
import { cdpCookieScopeKey, cdpSameSite, cookieScopeKey } from '../browser-cookie-clear-store'

/** 'value': only a session cookie was (re)set there, so Electron's list can tell its new value. */
export type ScopeChange = 'value' | 'other'

export function liveCookieScopeKey(cookie: Cookie): string | null {
  return cookieScopeKey(
    cookie.name,
    cookie.domain,
    cookie.path,
    cookie.hostOnly ?? !cookie.domain?.startsWith('.')
  )
}

export function groupByScope<T>(
  cookies: readonly T[],
  scopeKey: (cookie: T) => string | null
): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const cookie of cookies) {
    const key = scopeKey(cookie)
    if (!key) {
      continue
    }
    const group = groups.get(key)
    if (group) {
      group.push(cookie)
    } else {
      groups.set(key, [cookie])
    }
  }
  return groups
}

/** Whether a live cookie keeps the protections the saved one had; the value may differ. */
function sameCookieAttributes(saved: CdpCookie, live: Cookie): boolean {
  return (
    live.secure === saved.secure &&
    live.httpOnly === saved.httpOnly &&
    cdpSameSite(live.sameSite) === saved.sameSite
  )
}

export function noteScopeChange(
  changes: Map<string, ScopeChange>,
  key: string,
  change: ScopeChange
): void {
  if (changes.get(key) !== 'other') {
    changes.set(key, change)
  }
}

/**
 * The saved cookies with each changed scope's live value. Electron's list has no partition keys,
 * but when a scope's one saved cookie only saw inserts and overwrites and one live cookie is left,
 * no other key arrived, so that is the same cookie. Other changed scopes are dropped, and `certain`
 * says whether there were none.
 */
export function savedCookiesAfterChanges(
  saved: ReadonlyMap<string, CdpCookie[]>,
  changedScopes: ReadonlyMap<string, ScopeChange>,
  live: readonly Cookie[]
): { cookies: CdpCookie[]; certain: boolean } {
  const liveByScope = groupByScope(live, liveCookieScopeKey)
  let certain = [...changedScopes.keys()].every((key) => saved.has(key))
  const cookies = [...saved].flatMap(([key, savedInScope]) => {
    const change = changedScopes.get(key)
    if (!change) {
      return savedInScope
    }
    const [live, ...moreLive] = liveByScope.get(key) ?? []
    const [cookie] = savedInScope
    if (
      change === 'value' &&
      savedInScope.length === 1 &&
      live &&
      moreLive.length === 0 &&
      sameCookieAttributes(cookie, live)
    ) {
      return [{ ...cookie, value: live.value }]
    }
    certain = false
    return []
  })
  return { cookies, certain }
}

export function sameSavedCookies(
  a: ReadonlyMap<string, CdpCookie[]>,
  b: ReadonlyMap<string, CdpCookie[]>
): boolean {
  return (
    a.size === b.size &&
    [...a].every(([key, cookies]) => JSON.stringify(cookies) === JSON.stringify(b.get(key)))
  )
}

function partitionIdentity(cookie: CdpCookie): string {
  const key = cookie.partitionKey
  return JSON.stringify([key?.topLevelSite, key?.hasCrossSiteAncestor, cookie.partitionKeyOpaque])
}

/** Whether `cookies` holds this exact cookie identity: its scope and its partition. */
export function holdsCookie(cookies: readonly CdpCookie[], cookie: CdpCookie): boolean {
  const key = cdpCookieScopeKey(cookie)
  const identity = partitionIdentity(cookie)
  return cookies.some(
    (other) => cdpCookieScopeKey(other) === key && partitionIdentity(other) === identity
  )
}

/**
 * `cookies` with each cookie launch couldn't restore added back as saved, unless that exact one is
 * there. At quit (`live` from Electron, without partitions) an unpartitioned one whose scope holds
 * exactly one live cookie with its protections takes that newer value.
 */
export function withUnrestoredCookies(
  cookies: CdpCookie[],
  unrestored: ReadonlyMap<string, CdpCookie[]>,
  live?: readonly Cookie[]
): CdpCookie[] {
  const liveByScope = live ? groupByScope(live, liveCookieScopeKey) : null
  const missing = [...unrestored].flatMap(([key, members]) =>
    members
      .filter((member) => !holdsCookie(cookies, member))
      .map((member) => {
        const [only, ...more] = liveByScope?.get(key) ?? []
        const newer =
          only && more.length === 0 && !member.partitionKey && !member.partitionKeyOpaque
        return newer && sameCookieAttributes(member, only)
          ? { ...member, value: only.value }
          : member
      })
  )
  return missing.length === 0 ? cookies : [...cookies, ...missing]
}

/** After a CDP read of the live jar: a cookie it shows is live again, so live decides it from now on. */
export function forgetObservedUnrestored(
  unrestored: Map<string, CdpCookie[]>,
  live: readonly CdpCookie[]
): void {
  for (const [key, members] of unrestored) {
    const unseen = members.filter((member) => !holdsCookie(live, member))
    if (unseen.length === 0) {
      unrestored.delete(key)
    } else {
      unrestored.set(key, unseen)
    }
  }
}
