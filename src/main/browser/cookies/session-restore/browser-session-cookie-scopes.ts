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

/** A live read with each of `scopes` put back as saved (cookies the live jar can't show). */
export function withSavedScopes(
  live: CdpCookie[],
  saved: ReadonlyMap<string, CdpCookie[]>,
  scopes: ReadonlySet<string>
): CdpCookie[] {
  if (scopes.size === 0) {
    return live
  }
  const cookies = live.filter((cookie) => !scopes.has(cdpCookieScopeKey(cookie) ?? ''))
  for (const key of scopes) {
    cookies.push(...(saved.get(key) ?? []))
  }
  return cookies
}
