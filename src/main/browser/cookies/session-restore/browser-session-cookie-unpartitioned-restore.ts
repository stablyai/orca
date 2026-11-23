import type { Session } from 'electron'
import type { CdpCookie } from '../browser-cdp-cookie'
import { cdpCookieScopeKey, cookieScopeKey } from '../browser-cookie-clear-store'
import { planBrowserPartitionCookieCopy } from '../browser-partition-cookie-copy'
import { withCookieMutationLock } from '../mutation/cookie-mutation-lock'
import { liveCookieScopeKey } from './browser-session-cookie-scopes'

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
