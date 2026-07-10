import { browserSessionRegistry } from './browser-session-registry'
import type { BrowserSessionRegistryProfileOptions } from './browser-session-registry'

let initialized = false

export function initializeBrowserSessionsForApp(
  activeProfile?: BrowserSessionRegistryProfileOptions
): void {
  if (initialized) {
    return
  }

  if (activeProfile) {
    browserSessionRegistry.configureForOrcaProfile(activeProfile)
  }

  // Why: cookie replay must happen before the first session.fromPartition()
  // call, otherwise Chromium opens the stale live cookie DB before import.
  browserSessionRegistry.applyPendingCookieImport()
  browserSessionRegistry.initializeBrowserSessionsFromPersistedState()
  initialized = true
}
