import { BrowserError } from '../browser-error'
import { browserSessionRegistry } from '../browser-session-registry'
import { session, type Cookies } from 'electron'
import type { GoogleCookieClearResult } from '../../../shared/browser-google-cookie-clear'
import { withCookieMutationLock } from './browser-cookie-import-clear'
import {
  cookieRemovalUrl,
  isNonTransplantableCookieDomain,
  normalizeCookieDomain
} from './browser-cookie-import-policy'

export async function clearGoogleCookies(
  target: { cookies: Pick<Cookies, 'get' | 'remove'> },
  validate: () => void = () => {}
): Promise<GoogleCookieClearResult> {
  return withCookieMutationLock(target, async () => {
    validate()
    try {
      const googleCookies = (await target.cookies.get({})).filter((cookie) =>
        isNonTransplantableCookieDomain(cookie.domain ?? '')
      )
      if (googleCookies.length === 0) {
        return 'empty'
      }
      const selectors = new Map<string, { url: string; name: string }>()
      for (const cookie of googleCookies) {
        const domain = normalizeCookieDomain(cookie.domain ?? '')
        if (!domain) {
          continue
        }
        const url = cookieRemovalUrl(cookie, domain)
        selectors.set(JSON.stringify([url, cookie.name]), { url, name: cookie.name })
      }
      for (const { url, name } of selectors.values()) {
        validate()
        // An omitted partition selector removes every partition, including opaque ones.
        await target.cookies.remove(url, name).catch(() => {})
      }
      const remaining = (await target.cookies.get({})).some((cookie) =>
        isNonTransplantableCookieDomain(cookie.domain ?? '')
      )
      return remaining ? 'remaining' : 'cleared'
    } catch {
      return 'unverified'
    }
  })
}

export function clearGoogleCookiesFromPartition(
  partition: string,
  validate?: () => void
): Promise<GoogleCookieClearResult> {
  return clearGoogleCookies(session.fromPartition(partition), validate)
}

export function clearGoogleCookiesForRuntimeProfile(
  params: { profileId: string; executorRuntimeId: string },
  actualExecutorRuntimeId: string
): Promise<GoogleCookieClearResult> {
  if (params.executorRuntimeId !== actualExecutorRuntimeId) {
    throw new BrowserError('invalid_argument', 'The browser profile connection changed. Try again.')
  }
  const profile = browserSessionRegistry.getProfile(params.profileId)
  if (!profile) {
    throw new BrowserError('invalid_argument', 'Browser profile not found')
  }
  return clearGoogleCookiesFromPartition(profile.partition, () => {
    if (browserSessionRegistry.getProfile(params.profileId)?.partition !== profile.partition) {
      throw new BrowserError('invalid_argument', 'Browser profile not found')
    }
  })
}
