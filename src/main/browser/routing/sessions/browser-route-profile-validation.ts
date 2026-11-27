import { BrowserClientProfileMetadata } from '../../../../shared/browser/client-hosting/browser-client-profile-switch-protocol'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'

/** A server profile names itself through its metadata; only a bare id must be one of this desktop's profiles. */
export function validateBrowserRouteProfile(browserProfileId: string, metadata?: unknown): void {
  if (metadata) {
    if (BrowserClientProfileMetadata.parse(metadata).id !== browserProfileId) {
      throw new Error('browser_route_partition_profile_unavailable')
    }
    return
  }
  browserSessionRegistry.requireRouteBrowserProfile(browserProfileId)
}
