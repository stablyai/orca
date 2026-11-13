import { browserSessionRegistry } from './profiles/browser-session-registry'
import type { BrowserSessionRegistryProfileOptions } from './profiles/browser-session-registry'
import { collectOrphanedBrowserRoutePartitionStorage } from '../routing/partitions/browser-route-partition-storage-runtime'
// Initialize route registries and ownership probes before profile startup.
import '../routing/sessions/browser-route-session-runtime'
import { configureBrowserRoutePartitionBindingsForOrcaProfile } from '../routing/partitions/browser-route-partition-binding-runtime'
import { configureBrowserSitePermissionStore } from '../site-settings/permissions/browser-site-permission-store'
import { configureBrowserSiteDisplayStore } from '../site-settings/display/browser-site-display-store'
import { configureBrowserExtensionProfileDataDirectory } from '../extensions/profile-storage/browser-extension-profile-data-directory'
import { configurePairedRuntimeBrowserClientHostsForOrcaProfile } from '../client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'
import { configureBrowserPasswordVaults } from '../../browser-passwords/browser-password-vaults'
import { listenForBrowserPasskeyRequests } from '../webauthn/browser-passkey-requests'

let initialized = false

export function initializeBrowserSessionsForApp(
  activeProfile?: BrowserSessionRegistryProfileOptions & {
    listLocalSshTargetIds?: () => string[]
  }
): void {
  if (initialized) {
    return
  }
  listenForBrowserPasskeyRequests()

  if (activeProfile) {
    browserSessionRegistry.configureForOrcaProfile(activeProfile)
    configureBrowserSitePermissionStore(activeProfile.profileDirectory)
    configureBrowserSiteDisplayStore(activeProfile.profileDirectory)
    configureBrowserExtensionProfileDataDirectory(activeProfile.profileDirectory)
    configureBrowserPasswordVaults(activeProfile.profileDirectory)
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
  browserSessionRegistry.initializeBrowserSessionsFromPersistedState()
  initialized = true
}

/** Whether a partition may be opened: before this, opening one would skip a pending cookie import. */
export function browserSessionsInitialized(): boolean {
  return initialized
}
