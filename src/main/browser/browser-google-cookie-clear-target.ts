import type {
  BrowserCookieImportResult,
  BrowserSessionProfile
} from '../../shared/browser-workspace-types'
import type { GoogleCookieClearLocalTarget } from '../../shared/browser-google-cookie-clear'
import { bindRoutePartition } from './browser-client-route-cookie-import'
import { browserSessionRegistry } from './browser-session-registry'
import { getPairedRuntimeBrowserClientRouteIdentity } from './paired-runtime-browser-client-host-runtime'
import { clearGoogleCookiesFromPartition } from './cookies/browser-google-cookie-clear'

export function googleCookieClearLocalTarget(
  profileId: string,
  environmentId: string | null
): GoogleCookieClearLocalTarget | null {
  const identity = environmentId ? getPairedRuntimeBrowserClientRouteIdentity(environmentId) : null
  if (environmentId && !identity) {
    return null
  }
  const profile = browserSessionRegistry.getProfile(profileId)
  if (!profile) {
    throw new Error('Browser profile not found')
  }
  return {
    profileId,
    environmentId,
    partition: identity ? bindRoutePartition(identity, profileId) : profile.partition,
    routeIdentity: identity ? JSON.stringify(identity) : null
  }
}

export function clearGoogleCookiesForLocalTarget(target: GoogleCookieClearLocalTarget) {
  const current = googleCookieClearLocalTarget(target.profileId, target.environmentId)
  if (
    !current ||
    current.partition !== target.partition ||
    current.routeIdentity !== target.routeIdentity
  ) {
    throw new Error('The browser profile connection changed. Try again.')
  }
  const route = target.environmentId
    ? getPairedRuntimeBrowserClientRouteIdentity(target.environmentId)
    : null
  const partition = browserSessionRegistry.getProfile(target.profileId)?.partition
  return clearGoogleCookiesFromPartition(target.partition, () => {
    if (
      browserSessionRegistry.getProfile(target.profileId)?.partition !== partition ||
      (target.environmentId &&
        getPairedRuntimeBrowserClientRouteIdentity(target.environmentId) !== route)
    ) {
      throw new Error('The browser profile connection changed. Try again.')
    }
  })
}

export function retainLocalGoogleCookieClearTarget(
  result: Extract<BrowserCookieImportResult, { ok: true }>,
  profile: BrowserSessionProfile,
  profileId: string
): BrowserCookieImportResult {
  return {
    ...result,
    profileId,
    googleCookieClearTarget: {
      label: profile.label,
      local: {
        profileId: profile.id,
        environmentId: null,
        partition: profile.partition,
        routeIdentity: null
      }
    }
  }
}
