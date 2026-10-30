import { join } from 'node:path'
import { PluginImageCache } from '../plugins/plugin-image-cache'
import { installPluginImageProtocolHandler } from '../plugins/plugin-image-protocol'
import { pluginHostVersion } from '../../shared/plugins/installation/plugin-host-version'
import { app, BrowserWindow, net } from 'electron'
import { performance } from 'node:perf_hooks'
import { PluginService } from '../plugins/plugin-service'
import { PluginKillListService } from '../plugins/catalog/plugin-kill-list-service'
import { PluginMarketplaceService } from '../plugins/catalog/plugin-marketplace-service'
import { PluginMarketplaceInstaller } from '../plugins/catalog/plugin-marketplace-installer'
import { PluginAutoUpdater } from '../plugins/catalog/plugin-auto-updater'
import { PluginReleaseFirstSeenStore } from '../plugins/catalog/plugin-release-first-seen-store'
import { isPluginAutoUpdateOn } from '../../shared/plugins/catalog/plugin-update-policy'
import { PluginBundledBootstrapCoordinator } from '../plugins/plugin-bundled-bootstrap-coordinator'
import { getPluginsDataDir } from '../plugins/plugin-discovery'
import { resolveBundledPluginRoot } from '../plugins/plugin-bundled-bootstrap'
import { resolvePluginHostEntryPath } from '../plugins/workers/plugin-host-process'
import { applyPluginConsent, applyPluginEnablement } from '../plugins/plugin-enablement'
import { setPluginServiceForRpc } from '../runtime/rpc/methods/plugins'
import {
  normalizePluginConsents,
  normalizePluginIdList
} from '../../shared/plugins/approval/plugin-consent-state'
import { projectPluginAgentStatusChangedPayload } from '../plugins/plugin-agent-status-event'
import { setMainPluginLanguagePacks, setMainUiLanguage } from '../i18n/main-i18n'
import { isUsablePluginLanguagePack } from '../../shared/plugins/languages/plugin-language-pack-coverage'
import { rebuildAppMenu } from '../menu/register-app-menu'
import { rebuildSystemTrayMenu } from '../tray/system-tray'
import { logStartupMilestone } from './startup-diagnostics'
import { agentHookServer } from '../agent-hooks/server'
import { emitPluginWorktreeLifecycle } from './main-process-pty-startup'
import { mainProcessState as state } from './main-process-state'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const PLUGIN_AUTO_UPDATE_STARTUP_DELAY_MS = 60_000
// Why: the official catalog fetch must not compete with first paint; opening the marketplace seeds sooner.
const PLUGIN_MARKETPLACE_SEED_STARTUP_DELAY_MS = 15_000

export async function initializeMainProcessPlugins(runtime: OrcaRuntimeService): Promise<void> {
  const store = state.store
  const keybindings = state.keybindings
  if (!store || !keybindings) {
    throw new Error('Store and keybindings must be initialized before plugins')
  }
  const pluginSystemStartupStartedAt = performance.now()
  state.pluginKillListService = new PluginKillListService({
    pluginsDataDir: getPluginsDataDir(app.getPath('userData'))
  })
  await state.pluginKillListService.initialize()
  const pluginImageCache = new PluginImageCache(
    join(getPluginsDataDir(app.getPath('userData')), 'image-cache')
  )
  state.pluginMarketplaceService = new PluginMarketplaceService({
    imageCache: pluginImageCache,
    pluginsDataDir: getPluginsDataDir(app.getPath('userData')),
    getKillListEntry: (pluginKey) => state.pluginKillListService?.find(pluginKey) ?? null,
    hostVersion: pluginHostVersion(app.getVersion())
  })
  const requestOfficialMarketplaceSeed = (): void => {
    if (store.getSettings().pluginSystemEnabled !== true) {
      return
    }
    void state.pluginMarketplaceService
      ?.seedOfficialSource()
      .catch((error) =>
        console.warn('[plugins] failed to configure the official marketplace:', error)
      )
    void state.pluginMarketplaceService
      ?.seedCommunitySource()
      .catch((error) => console.warn('[plugins] failed to add the community marketplace:', error))
  }
  state.pluginMarketplaceInstaller = new PluginMarketplaceInstaller({
    marketplace: state.pluginMarketplaceService,
    userDataPath: app.getPath('userData'),
    hostVersion: pluginHostVersion(app.getVersion()),
    blockedPluginReason: (pluginKey) => state.pluginKillListService?.reason(pluginKey) ?? null,
    imageCache: pluginImageCache
  })
  state.pluginService = new PluginService({
    userDataPath: app.getPath('userData'),
    hostVersion: pluginHostVersion(app.getVersion()),
    // Feature flag: with the setting off, discovery returns nothing and no
    // plugin code path runs at all.
    isPluginSystemEnabled: () => state.store?.getSettings().pluginSystemEnabled === true,
    getDisabledPlugins: () => normalizePluginIdList(state.store?.getSettings().disabledPlugins),
    getPluginConsents: () => normalizePluginConsents(state.store?.getSettings().pluginConsents),
    getDevPluginPaths: () => normalizePluginIdList(state.store?.getSettings().devPluginPaths),
    getKeybindings: () => state.keybindings?.getOverrides() ?? {},
    getPluginKillListEntry: (pluginKey) => state.pluginKillListService?.find(pluginKey) ?? null,
    hostEntryPath: resolvePluginHostEntryPath(app.getAppPath(), app.isPackaged)
  })
  const pluginService = state.pluginService
  const pluginAutoUpdater = new PluginAutoUpdater({
    pluginService,
    installer: state.pluginMarketplaceInstaller,
    firstSeen: new PluginReleaseFirstSeenStore(getPluginsDataDir(app.getPath('userData'))),
    isEnabled: () => {
      const settings = store.getSettings()
      return settings.pluginSystemEnabled === true && isPluginAutoUpdateOn(settings)
    },
    refreshCatalogs: () => state.pluginMarketplaceService?.refreshAll() ?? Promise.resolve(),
    refreshKillList: () => state.pluginKillListService?.refresh() ?? Promise.resolve(),
    approve: (pluginKey, reviewedFingerprint) =>
      applyPluginConsent({
        store,
        pluginService,
        pluginKey,
        reviewedFingerprint,
        decision: 'approve'
      }),
    onChanged: (autoUpdate, updatedNow) => {
      const updated = Object.entries(updatedNow).map(([pluginKey, version]) => ({
        pluginKey,
        version,
        name: pluginService.findValidPlugin(pluginKey)?.manifest.name ?? pluginKey
      }))
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('plugins:autoUpdateChanged', { state: autoUpdate, updated })
        }
      }
    }
  })
  state.pluginAutoUpdater = pluginAutoUpdater
  // Why packaged only (like the safety list): dev and e2e runs must not update fixtures unasked.
  const autoUpdateScheduled = app.isPackaged || process.env.ORCA_PLUGIN_AUTO_UPDATE === '1'
  const syncPluginAutoUpdate = (runNow: boolean): void => {
    if (!autoUpdateScheduled) {
      return
    }
    const enabled =
      store.getSettings().pluginSystemEnabled === true && isPluginAutoUpdateOn(store.getSettings())
    pluginAutoUpdater.syncPeriodicRun(enabled)
    if (enabled && runNow) {
      void pluginAutoUpdater
        .run()
        .catch((error) => console.warn('[plugins] auto-update failed:', error))
    }
  }
  installPluginImageProtocolHandler({
    cache: pluginImageCache,
    findValidPlugin: (pluginKey) => state.pluginService?.findValidPlugin(pluginKey) ?? null
  })
  const bundledPluginBootstrap = new PluginBundledBootstrapCoordinator({
    root: resolveBundledPluginRoot({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    }),
    userDataPath: app.getPath('userData'),
    hostVersion: pluginHostVersion(app.getVersion()),
    isEnabled: () => state.store?.getSettings().pluginSystemEnabled === true,
    blockedPluginReason: (pluginKey) => state.pluginKillListService?.reason(pluginKey) ?? null,
    refreshPlugins: () => state.pluginService?.refresh() ?? Promise.resolve()
  })
  const requestBundledPluginBootstrap = (): void => {
    void bundledPluginBootstrap
      .request()
      .then((result) => {
        for (const failure of result?.errors ?? []) {
          console.warn(`[plugins] failed to publish bundled ${failure.pluginKey}:`, failure.error)
        }
      })
      .catch((error) => console.warn('[plugins] failed to bootstrap bundled plugins:', error))
  }
  state.pluginKillListService.onChanged(() => {
    void state.pluginService
      ?.reconcileActivationState()
      .catch((error) =>
        console.warn('[plugins] failed to apply plugin safety-list refresh:', error)
      )
  })
  store.onSettingsChanged((updates) => {
    if (updates.pluginSystemEnabled === true) {
      requestBundledPluginBootstrap()
      requestOfficialMarketplaceSeed()
    }
    if (app.isPackaged && updates.pluginSystemEnabled === true) {
      void state.pluginKillListService
        ?.refresh()
        .catch((error) =>
          console.warn('[plugins] failed to refresh plugin safety list; using cached state:', error)
        )
    }
    if (app.isPackaged && updates.pluginSystemEnabled !== undefined) {
      state.pluginKillListService?.syncPeriodicRefresh(updates.pluginSystemEnabled === true)
    }
    if (updates.pluginSystemEnabled !== undefined || updates.pluginUpdatePolicy !== undefined) {
      syncPluginAutoUpdate(true)
    }
  })
  // Headless RPC resolves this service too; consent shares the desktop hash-keyed write path.
  setPluginServiceForRpc(state.pluginService, {
    applyConsent: (request) =>
      applyPluginConsent({ store, pluginService: state.pluginService!, ...request }),
    applyEnablement: (pluginKey, enabled) =>
      applyPluginEnablement({ store, pluginService: state.pluginService!, pluginKey, enabled }),
    setDevPluginPaths: (devPluginPaths) =>
      store.updateSettings({ devPluginPaths }, { notifyListeners: true })
  })
  // Initialization discovers manifests only; workers/panel reads wait for explicit triggers.
  void state.pluginService
    .initialize()
    .then(() => {
      logStartupMilestone('plugin-system-initialized', {
        durationMs: Number((performance.now() - pluginSystemStartupStartedAt).toFixed(2)),
        installedPlugins: state.pluginService?.getDiscovered().length ?? 0
      })
      // Why delayed: catalog fetches and git checkouts must not compete with startup.
      setTimeout(() => syncPluginAutoUpdate(true), PLUGIN_AUTO_UPDATE_STARTUP_DELAY_MS).unref?.()
    })
    .catch((error) => console.warn('[plugins] failed to initialize plugin service:', error))
  if (app.isPackaged && store.getSettings().pluginSystemEnabled === true) {
    void state.pluginKillListService
      .refresh()
      .catch((error) =>
        console.warn('[plugins] failed to refresh plugin safety list; using cached state:', error)
      )
    state.pluginKillListService.syncPeriodicRefresh(true)
  }
  state.pluginService.onChanged((event) => {
    if (
      event.contentPacksChanged &&
      setMainPluginLanguagePacks(
        (state.pluginService?.contentPacks.languagePacks.list() ?? []).filter(
          isUsablePluginLanguagePack
        )
      )
    ) {
      void setMainUiLanguage(store.getSettings().uiLanguage).then(() => {
        rebuildAppMenu()
        rebuildSystemTrayMenu()
      })
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('plugins:changed', event)
      }
    }
  })
  requestBundledPluginBootstrap()
  setTimeout(() => {
    if (net.isOnline()) {
      requestOfficialMarketplaceSeed()
    }
  }, PLUGIN_MARKETPLACE_SEED_STARTUP_DELAY_MS).unref?.()
  // Filter hook/worktree events server-side by each plugin subscription.
  agentHookServer.subscribeEnrichedStatus((enriched) => {
    const payload = projectPluginAgentStatusChangedPayload(enriched)
    if (payload) {
      state.pluginService?.emitEvent('agent.status.changed', payload)
    }
  })
  runtime.onWorktreeLifecycle(emitPluginWorktreeLifecycle)
}
