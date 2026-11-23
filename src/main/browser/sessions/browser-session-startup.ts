import { browserSessionRegistry } from './profiles/browser-session-registry'
import type { BrowserSessionRegistryProfileOptions } from './profiles/browser-session-registry'
import { collectOrphanedBrowserRoutePartitionStorage } from '../routing/partitions/browser-route-partition-storage-runtime'
// Initialize route registries and ownership probes before profile startup.
import '../routing/sessions/browser-route-session-runtime'
import { configureBrowserRoutePartitionBindingsForOrcaProfile } from '../routing/partitions/browser-route-partition-binding-runtime'
import { configureBrowserSitePermissionStore } from '../site-settings/permissions/browser-site-permission-store'
import { configureBrowserSiteDisplayStore } from '../site-settings/display/browser-site-display-store'
import { configureBrowserBookmarkStore } from '../bookmarks/browser-bookmark-profile'
import { configureBrowserExtensionProfileDataDirectory } from '../extensions/profile-storage/browser-extension-profile-data-directory'
import { configurePairedRuntimeBrowserClientHostsForOrcaProfile } from '../client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'
import { configureBrowserPasswordVaults } from '../../browser-passwords/browser-password-vaults'
import { restoreBrowserSessionCookies } from '../cookies/session-restore/browser-session-cookie-restore'
import { configureBrowserSessionCookieSnapshots } from '../cookies/session-restore/browser-session-cookie-snapshot-file'
import { awaitBrowserSessionProxies } from './proxy/browser-session-proxy'
import { withTimeout } from '../../../shared/concurrency/promise-timeout-fallback'
import { listenForBrowserPasskeyRequests } from '../webauthn/browser-passkey-requests'
import { listenForBrowserSystemDialogs } from '../guest-lifecycle/prompts/browser-system-dialogs'
import { listenForBrowserGuestPageVisibility } from '../guest-lifecycle/visibility/browser-guest-page-visibility'

let initialized = false
let profilesRead = false

export function initializeBrowserSessionsForApp(
  activeProfile?: BrowserSessionRegistryProfileOptions & {
    listLocalSshTargetIds?: () => string[]
  }
): void {
  if (initialized) {
    return
  }
  listenForBrowserPasskeyRequests()
  listenForBrowserSystemDialogs()
  listenForBrowserGuestPageVisibility()

  if (activeProfile) {
    browserSessionRegistry.configureForOrcaProfile(activeProfile)
    configureBrowserSitePermissionStore(activeProfile.profileDirectory)
    configureBrowserSiteDisplayStore(activeProfile.profileDirectory)
    configureBrowserBookmarkStore(activeProfile.profileDirectory)
    configureBrowserExtensionProfileDataDirectory(activeProfile.profileDirectory)
    configureBrowserPasswordVaults(activeProfile.profileDirectory)
    configureBrowserSessionCookieSnapshots(activeProfile.profileDirectory)
    configureBrowserRoutePartitionBindingsForOrcaProfile({
      orcaProfileId: activeProfile.orcaProfileId,
      profileDirectory: activeProfile.profileDirectory
    })
    configurePairedRuntimeBrowserClientHostsForOrcaProfile({
      orcaProfileId: activeProfile.orcaProfileId
    })
    void collectOrphanedBrowserRoutePartitionStorage(activeProfile.listLocalSshTargetIds).catch(
      (error) => {
        console.warn('[browser-route-partition] orphan collection failed:', error)
      }
    )
  }

  // Replay cookies before Chromium opens the live DB via session.fromPartition.
  browserSessionRegistry.applyPendingCookieImport()
  profilesRead = browserSessionRegistry.initializeBrowserSessionsFromPersistedState()
  initialized = true
}

/** Whether a partition may be opened: before this, opening one would skip a pending cookie import. */
export function browserSessionsInitialized(): boolean {
  return initialized
}

/** Whether startup read the saved browser profiles; after a failed read a missing profile may not be deleted. */
export function browserSessionProfilesReadAtStartup(): boolean {
  return profilesRead
}

/** Restored tabs must load through their proxy and signed in. Extensions start with each profile's first page. */
export async function whenBrowserSessionsReadyForRestoredTabs(): Promise<void> {
  const profiles = browserSessionRegistry.listProfiles()
  // Why bounded: a slow cookie restore never blocks launch. Cookie writes need no proxy.
  const cookiesRestored = withTimeout(restoreBrowserSessionCookies(profiles), 3_000, undefined)
  try {
    // Await proxy writes so first guest navigation cannot race them.
    await awaitBrowserSessionProxies(profiles)
  } catch {
    console.warn('[proxy] Failed to apply network proxy settings to browser sessions')
  }
  await cookiesRestored
}
