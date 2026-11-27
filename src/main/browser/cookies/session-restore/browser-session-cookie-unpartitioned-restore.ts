import type { Session } from 'electron'
import type { CdpCookie } from '../browser-cdp-cookie'
import {
  cdpCookieScopeKey,
  cookieScopeKey,
  openCookieClearStore
} from '../browser-cookie-clear-store'
import {
  mergeCdpCookiesIntoSession,
  planBrowserPartitionCookieCopy
} from '../browser-partition-cookie-copy'
import { withCookieMutationLock } from '../mutation/cookie-mutation-lock'
import { holdsCookie, liveCookieScopeKey } from './browser-session-cookie-scopes'

/**
 * Why Electron's cookies API: it needs no hidden renderer per profile, which made launch wait
 * about 70 ms per profile. It drops partition keys, so it returns what only CDP can write:
 * partitioned cookies and any whose scope the jar already holds (perhaps as a partitioned twin).
 */
export async function restoreUnpartitionedCookies(
  target: Session,
  saved: CdpCookie[]
): Promise<CdpCookie[]> {
  return withCookieMutationLock(target, async () => {
    const present = new Set((await target.cookies.get({})).map(liveCookieScopeKey))
    const { writes } = planBrowserPartitionCookieCopy(
      saved.filter((cookie) => !cookie.partitionKey),
      [],
      { sameJar: true }
    )
    const restored = new Set<string>()
    await Promise.all(
      writes.map(
        async ({ url, name, value, domain, hostOnly, path, secure, httpOnly, sameSite }) => {
          const key = cookieScopeKey(name, domain, path, hostOnly ?? false)
          if (!key || present.has(key)) {
            return
          }
          try {
            await target.cookies.set({
              url,
              name,
              value,
              ...(hostOnly ? {} : { domain }),
              path,
              secure,
              httpOnly,
              sameSite
            })
            restored.add(key)
          } catch (error) {
            console.warn('[browser-session-cookies] Could not restore cookie', name, error)
          }
        }
      )
    )
    return saved.filter(
      (cookie) => cookie.partitionKey || !restored.has(cdpCookieScopeKey(cookie) ?? '')
    )
  })
}

/**
 * Writes over CDP what Electron's API could not. Returns the saved cookies the jar still lacks
 * afterwards, by exact identity, so a twin that did land isn't kept over its live value; all of
 * them when that can't be checked.
 */
export async function restoreLeftoverCookies(
  target: Session,
  saved: CdpCookie[],
  label: string
): Promise<CdpCookie[]> {
  try {
    const { copied } = await mergeCdpCookiesIntoSession(saved, target, { sameJar: true })
    if (copied === saved.length) {
      return []
    }
  } catch (error) {
    console.warn('[browser-session-cookies] Restore failed for', label, error)
  }
  try {
    const store = openCookieClearStore(target)
    try {
      const live = await store.readAllCdpCookies()
      return saved.filter((cookie) => !holdsCookie(live, cookie))
    } finally {
      store.dispose()
    }
  } catch {
    return saved
  }
}
