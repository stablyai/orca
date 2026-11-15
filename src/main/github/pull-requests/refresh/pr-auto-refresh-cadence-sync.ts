import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import {
  getPRAutoRefreshCadence,
  setPRAutoRefreshCadence
} from '../../../../shared/review-refresh-policy'
import { retimePRRefreshesForCadence } from './pr-refresh-coordinator'

/** Apply this host's PR auto-refresh setting to every main-process poller, now and on change.
 *  Runs for desktop and headless `orca serve` alike, so an operator can cap a shared box. */
export function syncPRAutoRefreshCadence(
  store: Pick<RuntimeStore, 'getSettings' | 'onSettingsChanged'> | null
): void {
  if (!store?.getSettings) {
    return
  }
  setPRAutoRefreshCadence(store.getSettings().prAutoRefresh)
  store.onSettingsChanged?.((updates, settings) => {
    if (!('prAutoRefresh' in updates)) {
      return
    }
    const before = getPRAutoRefreshCadence()
    setPRAutoRefreshCadence(settings.prAutoRefresh)
    if (getPRAutoRefreshCadence() !== before) {
      retimePRRefreshesForCadence()
    }
  })
}
