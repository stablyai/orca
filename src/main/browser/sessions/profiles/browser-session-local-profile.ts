import type { Session } from 'electron'
import { browserSessionRegistry } from './browser-session-registry'
import { localSshBrowserProfileIdForSession } from '../../routing/local-host-partitions/local-ssh-browser-partitions'
import { browserRouteSessionRegistry } from '../../routing/sessions/browser-route-session-runtime'

const DEFAULT_BROWSER_PROFILE_ID = 'default'

/**
 * The local browser profile a guest session belongs to: the profile's own partition, an SSH page
 * opened with it, or a This-device page of the server's default profile, which this desktop's
 * default stands in for. Every other server profile is the server's own, even when its id matches.
 */
export function localBrowserProfileIdForSession(webSession: Session): string | null {
  const own = browserSessionRegistry.profileIdForSession(webSession)
  if (own) {
    return own
  }
  const ssh = localSshBrowserProfileIdForSession(webSession)
  if (ssh) {
    return ssh
  }
  const serverProfileId = browserRouteSessionRegistry.getBrowserProfileIdForSession(webSession)
  return serverProfileId === DEFAULT_BROWSER_PROFILE_ID &&
    browserSessionRegistry.getProfile(DEFAULT_BROWSER_PROFILE_ID)
    ? DEFAULT_BROWSER_PROFILE_ID
    : null
}
