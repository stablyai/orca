import { app, type Session } from 'electron'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { localBrowserProfileIdForSession } from '../../sessions/profiles/browser-session-local-profile'
import { localSshBrowserPartitionForSession } from '../../routing/local-host-partitions/local-ssh-browser-partitions'
import { browserRouteSessionRegistry } from '../../routing/sessions/browser-route-session-runtime'
import { enforceBrowserRouteWebRtcPolicy } from '../../network/egress/browser-route-webrtc-policy'
import { linkBrowserExtensionRouteProfile } from './browser-extension-route-profiles'
import { isBrowserExtensionSidePanelGuest } from '../side-panel/browser-extension-side-panel-guests'

/**
 * The extension profile id for an SSH page's session, or a This-device page's of the server's
 * Default profile: the local profile it stands for, as its saved passwords use. Null for any other
 * session, server profiles included, whose extensions live on the server.
 */
export function linkBrowserExtensionsToRouteSession(webSession: Session): string | null {
  const sshPartition = localSshBrowserPartitionForSession(webSession)
  const partition = sshPartition ?? browserRouteSessionRegistry.getPartitionForSession(webSession)
  const sourceProfileId = partition ? localBrowserProfileIdForSession(webSession) : null
  const source = sourceProfileId ? browserSessionRegistry.getProfile(sourceProfileId) : null
  if (!partition || !source) {
    return null
  }
  if (!sshPartition) {
    ensureServerRouteExtensionWebRtcGuard()
  }
  return linkBrowserExtensionRouteProfile(partition, source)
}

let webRtcGuardInstalled = false
// Why: the route fences only the pages it registers; extension popups, windows and side panels in
// its session need the same proxied-only WebRTC (SSH sessions fence every new WebContents already).
function ensureServerRouteExtensionWebRtcGuard(): void {
  if (webRtcGuardInstalled) {
    return
  }
  webRtcGuardInstalled = true
  app.on('web-contents-created', (_event, contents) => {
    if (
      (contents.getType() !== 'webview' || isBrowserExtensionSidePanelGuest(contents)) &&
      browserRouteSessionRegistry.getPartitionForSession(contents.session)
    ) {
      enforceBrowserRouteWebRtcPolicy(contents, () => {})
    }
  })
}
