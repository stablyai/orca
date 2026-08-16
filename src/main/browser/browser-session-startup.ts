import { browserSessionRegistry } from './browser-session-registry'
import type { BrowserSessionRegistryProfileOptions } from './browser-session-registry'
import { configureRouteSessionsForOrcaProfile } from './browser-route-session-runtime'
import { configurePairedRuntimeBrowserClientHostsForOrcaProfile } from './paired-runtime-browser-client-host-runtime'

let initialized = false

export function initializeBrowserSessionsForApp(
  activeProfile?: BrowserSessionRegistryProfileOptions
): void {
  if (initialized) {
    return
  }

  if (activeProfile) {
    browserSessionRegistry.configureForOrcaProfile(activeProfile)
    configureRouteSessionsForOrcaProfile({ profileDirectory: activeProfile.profileDirectory })
    configurePairedRuntimeBrowserClientHostsForOrcaProfile({
      orcaProfileId: activeProfile.orcaProfileId
    })
  }

  // Why: cookie replay must happen before the first session.fromPartition()
  // call, otherwise Chromium opens the stale live cookie DB before import.
  browserSessionRegistry.applyPendingCookieImport()
  browserSessionRegistry.initializeBrowserSessionsFromPersistedState()
  initialized = true
}
