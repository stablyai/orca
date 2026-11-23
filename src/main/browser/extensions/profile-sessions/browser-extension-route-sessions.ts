import type { Session } from 'electron'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { localBrowserProfileIdForSession } from '../../sessions/profiles/browser-session-local-profile'
import { localSshBrowserPartitionForSession } from '../../routing/local-host-partitions/local-ssh-browser-partitions'
import { browserRouteSessionRegistry } from '../../routing/sessions/browser-route-session-runtime'
import { linkBrowserExtensionRouteProfile } from './browser-extension-route-profiles'

/**
 * The extension profile id for an SSH page's session, or a This-device page's of the server's
 * Default profile: the local profile it stands for, as its saved passwords use. Null for any other
 * session, server profiles included, whose extensions live on the server.
 */
export function linkBrowserExtensionsToRouteSession(webSession: Session): string | null {
  const partition =
    localSshBrowserPartitionForSession(webSession) ??
    browserRouteSessionRegistry.getPartitionForSession(webSession)
  const sourceProfileId = partition ? localBrowserProfileIdForSession(webSession) : null
  const source = sourceProfileId ? browserSessionRegistry.getProfile(sourceProfileId) : null
  return partition && source ? linkBrowserExtensionRouteProfile(partition, source) : null
}
