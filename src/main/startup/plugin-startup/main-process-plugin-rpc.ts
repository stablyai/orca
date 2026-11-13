import type { Store } from '../../persistence/loading-store/store'
import { applyPluginConsent, applyPluginEnablement } from '../../plugins/plugin-enablement'
import type { PluginService } from '../../plugins/plugin-service'
import type { PluginCliCatalogs } from '../../plugins/plugin-cli-catalog-candidates'
import { clearPluginFrameStorage } from '../../plugins/panels/guest-isolation/plugin-frame-guest-sessions'
import { openPluginFrameGuestDevTools } from '../../plugins/panels/guest-isolation/plugin-frame-guest-diagnostics'
import { setPluginServiceForRpc } from '../../runtime/rpc/methods/plugins/plugins'
import { setPluginInstallServicesForRpc } from '../../runtime/rpc/methods/plugins/plugin-install-methods'

/** Headless RPC resolves these too; consent shares the desktop hash-keyed write path. */
export function bindPluginRpcServices(
  store: Store,
  pluginService: PluginService,
  catalogs: PluginCliCatalogs
): void {
  setPluginServiceForRpc(pluginService, {
    applyConsent: (request) => applyPluginConsent({ store, pluginService, ...request }),
    applyEnablement: (pluginKey, enabled) =>
      applyPluginEnablement({ store, pluginService, pluginKey, enabled }),
    setPluginSystemEnabled: (pluginSystemEnabled) =>
      store.updateSettings({ pluginSystemEnabled }, { notifyListeners: true }),
    setDevPluginPaths: (devPluginPaths) =>
      store.updateSettings({ devPluginPaths }, { notifyListeners: true }),
    openFrameDevTools: openPluginFrameGuestDevTools
  })
  setPluginInstallServicesForRpc({
    pluginService,
    catalogs,
    applyConsent: (request) => applyPluginConsent({ store, pluginService, ...request }),
    store,
    afterUninstall: clearPluginFrameStorage
  })
}
