import { session } from 'electron'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { isLocalSshBrowserPartition } from '../../routing/local-host-partitions/local-ssh-browser-partitions'
import { browserRouteSessionRegistry } from '../../routing/sessions/browser-route-session-runtime'
import { linkBrowserExtensionsToRouteSession } from './browser-extension-route-sessions'
import { whenBrowserExtensionsStartFor } from './browser-extension-page-start'
import { getAttachedBrowserExtensionProfileId } from './browser-extension-session-loader'
import { isBrowserExtensionSupportEnabled } from '../browser-extension-support'

/**
 * Starts the extensions a page in this partition runs and resolves once a page there may be
 * created, as a browser restores tabs only after the profile's extensions load: a request in flight
 * when a webRequest extension loads is dropped by Electron, so the page must not exist before then.
 * Resolves at once when nothing is starting.
 */
export function whenBrowserPartitionReadyForPage(partition: string): Promise<void> {
  if (!isBrowserExtensionSupportEnabled()) {
    return Promise.resolve()
  }
  // Attached already (every page but a profile's first): no lookup over every saved profile.
  const attached = getAttachedBrowserExtensionProfileId(partition)
  if (attached) {
    return whenBrowserExtensionsStartFor(attached) ?? Promise.resolve()
  }
  const profileId =
    browserSessionRegistry.profileIdForPartition(partition) ??
    (browserRouteSessionRegistry.isAllowedPartition(partition) ||
    isLocalSshBrowserPartition(partition)
      ? linkBrowserExtensionsToRouteSession(session.fromPartition(partition))
      : null)
  if (!profileId) {
    return Promise.resolve()
  }
  browserSessionRegistry.attachExtensions(profileId)
  return whenBrowserExtensionsStartFor(profileId) ?? Promise.resolve()
}
