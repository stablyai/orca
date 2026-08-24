import { session, type Cookie } from 'electron'
import { openCookieClearStore } from './browser-cookie-clear-store'
import {
  removePlannedCookieEntries,
  withCookieMutationLock,
  type CookieClearSession
} from './browser-cookie-import-clear'
import {
  cookieRemovalUrl,
  isNonTransplantableCookieDomain,
  normalizeCookieDomain
} from './browser-cookie-import-policy'

function nonTransplantableCookieEntries(
  cookies: readonly Cookie[]
): { cookie: Cookie; url: string }[] {
  const removable: { cookie: Cookie; url: string }[] = []
  for (const cookie of cookies) {
    if (!isNonTransplantableCookieDomain(cookie.domain ?? '')) {
      continue
    }
    const scopedDomain = cookie.domain ? normalizeCookieDomain(cookie.domain) : null
    if (scopedDomain === null) {
      continue
    }
    removable.push({ cookie, url: cookieRemovalUrl(cookie, scopedDomain) })
  }
  return removable
}

/**
 * Removes only non-transplantable (currently Google-family) cookies.
 *
 * Why (STA-4398): imports neither write nor clear this family, so stale Google
 * cookies have no other exit. The plan is an include-list of that family — never
 * clearStorageData / a whole-jar wipe, which would sign the user out of every
 * other site in the partition (STA-4797).
 */
export async function removeNonTransplantableCookies(
  targetSession: CookieClearSession
): Promise<void> {
  return withCookieMutationLock(targetSession, async () => {
    const cookies = await targetSession.cookies.get({})
    await removePlannedCookieEntries(targetSession, nonTransplantableCookieEntries(cookies))
  })
}

export async function clearGoogleCookiesForPartition(partition: string): Promise<boolean> {
  try {
    const targetSession = session.fromPartition(partition)
    return await withCookieMutationLock(targetSession, async () => {
      const store = openCookieClearStore(targetSession)
      try {
        await removeNonTransplantableCookies({
          cookies: store,
          snapshotClearIdentities: (cookies) => store.snapshotClearIdentities(cookies),
          restoreClearIdentities: (identities) => store.restoreClearIdentities(identities)
        })
        return true
      } finally {
        store.dispose()
      }
    })
  } catch {
    return false
  }
}
