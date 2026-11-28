import { app } from 'electron'
import { pluginHostVersion } from '../../../shared/plugins/installation/plugin-host-version'
import type { DesktopCore } from '../../core-desktop/desktop-core'
import type { Store } from '../../persistence/loading-store/store'
import type { PluginBundledBootstrapCoordinator } from '../../plugins/bootstrap/plugin-bundled-bootstrap-coordinator'
import type { PluginService } from '../../plugins/plugin-service'

/** Defers loading bundled-plugin bootstrap and retirement helpers until plugins are enabled. */
export function createLazyBundledPluginBootstrapRequester(
  core: DesktopCore,
  store: Store,
  pluginService: PluginService,
  bundledPluginRoot: string
): () => void {
  let coordinatorPromise: Promise<PluginBundledBootstrapCoordinator> | null = null
  const getCoordinator = (): Promise<PluginBundledBootstrapCoordinator> =>
    (coordinatorPromise ??= Promise.all([
      import('../../plugins/bootstrap/plugin-bundled-bootstrap-coordinator'),
      import('../../plugins/bootstrap/plugin-bundled-approval'),
      import('../../plugins/installation/plugin-removal-settings'),
      import('../../plugins/panels/guest-isolation/plugin-frame-guest-sessions')
    ]).then(
      ([
        { PluginBundledBootstrapCoordinator },
        { approveBundledPluginsFromStore },
        { clearRemovedPluginSettings },
        { clearPluginFrameStorage }
      ]) =>
        new PluginBundledBootstrapCoordinator({
          root: bundledPluginRoot,
          userDataPath: app.getPath('userData'),
          hostVersion: pluginHostVersion(app.getVersion()),
          isEnabled: () => store.getSettings().pluginSystemEnabled === true,
          blockedPluginReason: (pluginKey) => core.pluginKillListService?.reason(pluginKey) ?? null,
          // Why: a retired bundled plugin must not leave consent, theme choices or frame storage behind.
          beforeRetire: (pluginKey) => clearRemovedPluginSettings(store, pluginKey),
          afterRetire: (pluginKey) => clearPluginFrameStorage(pluginKey),
          refreshPlugins: () => core.pluginService?.refresh() ?? Promise.resolve(),
          approveContentPlugins: (pluginKeys) =>
            approveBundledPluginsFromStore(store, pluginService, pluginKeys)
        })
    ))

  return (): void => {
    if (store.getSettings().pluginSystemEnabled !== true) {
      return
    }
    void getCoordinator()
      .then((coordinator) => coordinator.request())
      .then((result) => {
        for (const failure of result?.errors ?? []) {
          console.warn(`[plugins] failed to publish bundled ${failure.pluginKey}:`, failure.error)
        }
      })
      .catch((error) => console.warn('[plugins] failed to bootstrap bundled plugins:', error))
  }
}
