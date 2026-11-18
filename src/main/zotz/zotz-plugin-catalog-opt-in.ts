import { app } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import { mainProcessState as state } from '../startup/main-process-state'
import { bindZotzPluginCatalogOptIn } from './zotz-plugin-catalog-guard'

/** Binds the opt-in and starts or stops Orca's plugin safety list when the user flips it. */
export function startZotzPluginCatalogOptIn(store: Store): void {
  bindZotzPluginCatalogOptIn(() => store.getSettings().zotzOrcaPluginCatalogEnabled === true)
  store.onSettingsChanged((updates) => {
    if (!('zotzOrcaPluginCatalogEnabled' in updates) || !app.isPackaged) {
      return
    }
    const active =
      updates.zotzOrcaPluginCatalogEnabled === true &&
      store.getSettings().pluginSystemEnabled === true
    state.pluginKillListService?.syncPeriodicRefresh(active)
    if (active) {
      void state.pluginKillListService
        ?.refresh()
        .catch((error) => console.warn('[zotz] failed to refresh plugin safety list:', error))
    }
  })
}
