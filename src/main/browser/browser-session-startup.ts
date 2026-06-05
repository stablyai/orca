import { browserSessionRegistry } from './browser-session-registry'

let initialized = false

export function initializeBrowserSessionsForApp(): void {
  if (initialized) {
    return
  }

  // Why: cookie replay must happen before the first session.fromPartition()
  // call, otherwise Chromium opens the stale live cookie DB before import.
  browserSessionRegistry.applyPendingCookieImport()
  browserSessionRegistry.initializeBrowserSessionsFromPersistedState()
  initialized = true
}
