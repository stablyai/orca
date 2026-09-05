import {
  setupAutoUpdater,
  resolveUpdateInstallMode,
  setServeUpdateCensusGate,
  setServeUpdateCensusRuntime,
  setServeUpdateRuntimeId
} from '../updater'
import { runServeUpdateCensus, type CensusCapableRuntime } from '../serve-update-census'
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
  getStore: () => NonNullable<typeof state.store>,
  censusRuntime?: CensusCapableRuntime
): void {
  setServeUpdateRuntimeId(runtimeId)
  // Why: on Linux serve, the install RPC ends in a service restart that kills every
  // terminal and agent. The census gate runs at install time to refuse the update
  // while live work exists (see docs/reference/ssh-execution-boundary.md).
  if (censusRuntime) {
    setServeUpdateCensusGate(() => runServeUpdateCensus(censusRuntime))
    setServeUpdateCensusRuntime(censusRuntime)
  }
  setupAutoUpdater(null, {
    getLastUpdateCheckAt: () => getStore().getUI().lastUpdateCheckAt,
    setLastUpdateCheckAt: (timestamp) => {
      getStore().updateUI({ lastUpdateCheckAt: timestamp })
    },
    installMode: resolveUpdateInstallMode(state.isServeMode)
  })
}
