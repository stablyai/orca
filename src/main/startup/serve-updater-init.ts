import { setupAutoUpdater, resolveUpdateInstallMode, setServeUpdateRuntimeId } from '../updater'
import { mainProcessState as state } from './main-process-state'

/**
 * Arms the updater for a headless serve process.
 *
 * Why a null "main window": setupAutoUpdater uses the window only to publish status to a
 * renderer; every use is `?.`-guarded, so serve publishes into the void safely. Why no
 * deferred setup: there is no first paint to defer past.
 */
export function initializeServeAutoUpdater(
  runtimeId: string,
  getStore: () => NonNullable<typeof state.store>
): void {
  setServeUpdateRuntimeId(runtimeId)
  setupAutoUpdater(null, {
    getLastUpdateCheckAt: () => getStore().getUI().lastUpdateCheckAt,
    setLastUpdateCheckAt: (timestamp) => {
      getStore().updateUI({ lastUpdateCheckAt: timestamp })
    },
    installMode: resolveUpdateInstallMode(state.isServeMode)
  })
}
