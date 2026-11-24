import { join } from 'node:path'
import { PluginImageCache } from '../../plugins/media/plugin-image-cache'
import { installPluginImageProtocolHandler } from '../../plugins/media/plugin-image-protocol'
import { getPluginDesktopFrameServices } from '../../plugins/panels/desktop-actions/plugin-frame-desktop-services'
import { pluginHostVersion } from '../../../shared/plugins/installation/plugin-host-version'
import { app, BrowserWindow, net } from 'electron'
import { performance } from 'node:perf_hooks'
import { PluginService } from '../../plugins/plugin-service'
import { PluginKillListService } from '../../plugins/catalog/plugin-kill-list-service'
import { PluginInstallStatsService } from '../../plugins/catalog/plugin-install-stats-service'
import { PluginMarketplaceService } from '../../plugins/catalog/plugin-marketplace-service'
import { getCatalogManagingTeams } from '../../plugins/catalog/plugin-marketplace-team-policy'
import { PluginMarketplaceInstaller } from '../../plugins/catalog/plugin-marketplace-installer'
import { PluginAutoUpdater } from '../../plugins/catalog/plugin-auto-updater'
import { PluginReleaseFirstSeenStore } from '../../plugins/catalog/plugin-release-first-seen-store'
import { PluginUpdateReviewNotices } from '../../plugins/catalog/plugin-update-review-notices'
import { isPluginAutoUpdateOn } from '../../../shared/plugins/catalog/plugin-update-policy'
import { PluginBundledBootstrapCoordinator } from '../../plugins/bootstrap/plugin-bundled-bootstrap-coordinator'
import { getPluginsDataDir } from '../../plugins/discovery/plugin-discovery'
import { bundledPluginRootForApp } from '../../plugins/bootstrap/plugin-bundled-bootstrap'
import { approveBundledPluginsFromStore } from '../../plugins/bootstrap/plugin-bundled-approval'
import { resolvePluginHostEntryPath } from '../../plugins/workers/parent-process/plugin-host-process'
import { applyPluginConsent, revokePluginConsent } from '../../plugins/activation/plugin-enablement'
import { clearRemovedPluginSettings } from '../../plugins/installation/plugin-removal-settings'
import { clearPluginFrameStorage } from '../../plugins/panels/guest-isolation/plugin-frame-guest-sessions'
import { bindPluginRpcServices } from './main-process-plugin-rpc'
import { bindPluginDesktopViews } from '../../plugins/view/plugin-view-desktop-binding'
import {
  normalizePluginConsents,
  normalizePluginIdList
} from '../../../shared/plugins/approval/plugin-consent-state'
import { projectPluginAgentStatusChangedPayload } from '../../plugins/events/plugin-agent-status-event'
import { logStartupMilestone } from '../diagnostics/startup-diagnostics'
import { agentHookServer } from '../../agent-hooks/server/agent-hook-server'
import {
  bindPluginRuntime,
  createPluginAgentStatusForwarder,
  watchPluginWorkspaceContext
} from '../../plugins/runtime/plugin-runtime-binding'
import { emitPluginWorktreeLifecycle } from '../pty-startup/main-process-pty-startup'
import { mainProcessState as state } from '../main-process-state'
import type { DesktopCore } from '../../core-desktop/desktop-core'
import type { Store } from '../../persistence/loading-store/store'
import { PluginStatusBarState } from '../../plugins/status-bar/plugin-status-bar-state'
import { createDesktopPluginAppearance } from '../../plugins/appearance/desktop-plugin-appearance'
import { bindPluginEditorTypography } from '../../plugins/appearance/plugin-editor-typography'
import { bindDesktopPluginNotices } from './desktop-plugin-notices'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods/rpc-method-registry'
import { getActiveTeamCapabilities } from '../../orca-profiles/cloud-auth/active-team-capabilities'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS } from '../../../shared/orca-profiles/orca-cloud-team-policy'
import { watchTeamPluginPolicy } from './team-plugin-policy-reconciliation'
import {
  findTeamPluginBlock,
  getRequiredTeamPlugins
} from '../../plugins/installation/plugin-team-install-policy'

const PLUGIN_AUTO_UPDATE_STARTUP_DELAY_MS = 60_000
// Why: the official catalog fetch must not compete with first paint; opening the marketplace seeds sooner.
const PLUGIN_MARKETPLACE_SEED_STARTUP_DELAY_MS = 15_000

export async function initializeMainProcessPlugins(core: DesktopCore, store: Store): Promise<void> {
  const { keybindings, runtime } = core
  if (!keybindings || !runtime) {
    throw new Error('Keybindings and runtime must be initialized before plugins')
  }
  const pluginSystemStartupStartedAt = performance.now()
  const pluginsDataDir = getPluginsDataDir(app.getPath('userData'))
  core.pluginKillListService = new PluginKillListService({ pluginsDataDir })
  await core.pluginKillListService.initialize()
  const getPluginBlock = (key: string) =>
    core.pluginKillListService?.find(key) ?? findTeamPluginBlock(key)
  core.pluginInstallStatsService = new PluginInstallStatsService({
    pluginsDataDir,
    // Why packaged only (like the safety list): dev and e2e runs must not reach the network unasked.
    isFetchAllowed: () =>
      store.getSettings().pluginSystemEnabled === true &&
      (app.isPackaged || process.env.ORCA_PLUGIN_INSTALL_STATS === '1')
  })
  core.pluginInstallStatsService.onChanged(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('plugins:installCountsChanged')
      }
    }
  })
  const pluginImageCache = new PluginImageCache(join(pluginsDataDir, 'image-cache'))
  core.pluginMarketplaceService = new PluginMarketplaceService({
    imageCache: pluginImageCache,
    pluginsDataDir,
    getKillListEntry: getPluginBlock,
    hostVersion: pluginHostVersion(app.getVersion()),
    getTeamCapabilities: getActiveTeamCapabilities
  })
  const requestOfficialMarketplaceSeed = (): void => {
    if (store.getSettings().pluginSystemEnabled !== true) {
      return
    }
    void core.pluginMarketplaceService
      ?.seedOfficialSource()
      .catch((error) =>
        console.warn('[plugins] failed to configure the official marketplace:', error)
      )
    void core.pluginMarketplaceService
      ?.seedCommunitySource()
      .catch((error) => console.warn('[plugins] failed to add the community marketplace:', error))
  }
  core.pluginMarketplaceInstaller = new PluginMarketplaceInstaller({
    marketplace: core.pluginMarketplaceService,
    userDataPath: app.getPath('userData'),
    hostVersion: pluginHostVersion(app.getVersion()),
    blockedPluginReason: (pluginKey) => core.pluginKillListService?.reason(pluginKey) ?? null,
    imageCache: pluginImageCache,
    revokeConsent: (pluginKey) =>
      revokePluginConsent({ store, pluginService: core.pluginService, pluginKey }),
    reconcileConsent: () => core.pluginService?.reconcileActivationState() ?? Promise.resolve()
  })
  const bundledPluginRoot = bundledPluginRootForApp(app)
  core.pluginService = new PluginService({
    userDataPath: app.getPath('userData'),
    hostVersion: pluginHostVersion(app.getVersion()),
    // Feature flag: with the setting off, discovery returns nothing and no
    // plugin code path runs at all.
    isPluginSystemEnabled: () =>
      store.getSettings().pluginSystemEnabled === true &&
      getActiveTeamCapabilities()?.flags[ORCA_CLOUD_TEAM_POLICY_FLAGS.plugins] !== false,
    getDisabledPlugins: () => normalizePluginIdList(store.getSettings().disabledPlugins),
    getRequiredPlugins: getRequiredTeamPlugins,
    getCatalogManagingTeams: (source) =>
      getCatalogManagingTeams(source, getActiveTeamCapabilities()),
    getPluginConsents: () => normalizePluginConsents(store.getSettings().pluginConsents),
    getDevPluginPaths: () => normalizePluginIdList(store.getSettings().devPluginPaths),
    getKeybindings: () => core.keybindings?.getOverrides() ?? {},
    getPluginKillListEntry: getPluginBlock,
    hostEntryPath: resolvePluginHostEntryPath(app.getAppPath(), app.isPackaged),
    getDesktopFrameServices: getPluginDesktopFrameServices,
    statusBar: new PluginStatusBarState(),
    appearance: createDesktopPluginAppearance(store, () => core.pluginService),
    editorTypography: bindPluginEditorTypography(store, () => core.pluginService),
    bundledPluginRoot
  })
  const pluginService = core.pluginService
  core.stopTeamPluginPolicy?.()
  core.stopTeamPluginPolicy = watchTeamPluginPolicy(
    pluginService,
    core.pluginMarketplaceService,
    core.pluginMarketplaceInstaller,
    PLUGIN_MARKETPLACE_SEED_STARTUP_DELAY_MS,
    store
  )
  const pluginAutoUpdater = new PluginAutoUpdater({
    pluginService,
    installer: core.pluginMarketplaceInstaller,
    firstSeen: new PluginReleaseFirstSeenStore(getPluginsDataDir(app.getPath('userData'))),
    isEnabled: () => {
      const settings = store.getSettings()
      return settings.pluginSystemEnabled === true && isPluginAutoUpdateOn(settings)
    },
    refreshCatalogs: () => core.pluginMarketplaceService?.refreshAll() ?? Promise.resolve(),
    refreshKillList: () => core.pluginKillListService?.refresh() ?? Promise.resolve(),
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
  core.pluginAutoUpdater = pluginAutoUpdater
  core.pluginUpdateReviewNotices = new PluginUpdateReviewNotices({
    pluginsDataDir: getPluginsDataDir(app.getPath('userData')),
    getHeld: () => pluginAutoUpdater.getHeldForReview(),
    findName: (pluginKey) => pluginService.findValidPlugin(pluginKey)?.manifest.name ?? null,
    isKillListed: (pluginKey) => Boolean(getPluginBlock(pluginKey))
  })
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
    findValidPlugin: (pluginKey) => core.pluginService?.findValidPlugin(pluginKey) ?? null,
    findApprovedPlugin: (pluginKey) =>
      core.pluginService?.findApprovedPlugin(pluginKey, true) ?? null
  })
  const bundledPluginBootstrap = new PluginBundledBootstrapCoordinator({
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
  core.pluginKillListService.onChanged(() => {
    void core.pluginService
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
      void core.pluginKillListService
        ?.refresh()
        .catch((error) =>
          console.warn('[plugins] failed to refresh plugin safety list; using cached state:', error)
        )
    }
    if (app.isPackaged && updates.pluginSystemEnabled !== undefined) {
      core.pluginKillListService?.syncPeriodicRefresh(updates.pluginSystemEnabled === true)
    }
    if (updates.pluginSystemEnabled !== undefined || updates.pluginUpdatePolicy !== undefined) {
      syncPluginAutoUpdate(true)
    }
    if ('pluginSystemEnabled' in updates || 'devPluginPaths' in updates) {
      // Main owns lifecycle refresh even when a caller crashes before its follow-up refresh.
      void pluginService.refresh().catch((error) => {
        console.warn('[plugins] failed to apply plugin settings change:', error)
      })
    }
  })
  // Bound here, not in the IPC handlers: a headless serve never opens a window to register them.
  const pluginDelegate = bindPluginRuntime(pluginService, runtime, agentHookServer, ALL_RPC_METHODS)
  bindPluginRpcServices(store, pluginService, {
    marketplace: core.pluginMarketplaceService,
    installer: core.pluginMarketplaceInstaller
  })
  bindPluginDesktopViews(state.isServeMode, pluginService, () => state.mainWindow)
  // Initialization discovers manifests only; workers/panel reads wait for explicit triggers.
  void core.pluginService
    .initialize()
    .then(() => {
      logStartupMilestone('plugin-system-initialized', {
        durationMs: Number((performance.now() - pluginSystemStartupStartedAt).toFixed(2)),
        installedPlugins: core.pluginService?.getDiscovered().length ?? 0
      })
      // Why delayed: catalog fetches and git checkouts must not compete with startup.
      setTimeout(() => syncPluginAutoUpdate(true), PLUGIN_AUTO_UPDATE_STARTUP_DELAY_MS).unref?.()
    })
    .catch((error) => console.warn('[plugins] failed to initialize plugin service:', error))
  if (app.isPackaged && store.getSettings().pluginSystemEnabled === true) {
    void core.pluginKillListService
      .refresh()
      .catch((error) =>
        console.warn('[plugins] failed to refresh plugin safety list; using cached state:', error)
      )
    core.pluginKillListService.syncPeriodicRefresh(true)
  }
  bindDesktopPluginNotices(pluginService, store)
  requestBundledPluginBootstrap()
  setTimeout(() => {
    if (net.isOnline()) {
      requestOfficialMarketplaceSeed()
    }
  }, PLUGIN_MARKETPLACE_SEED_STARTUP_DELAY_MS).unref?.()
  // Filter hook/worktree events server-side by each plugin subscription.
  const forwardAgentStatus = createPluginAgentStatusForwarder(pluginDelegate, pluginService)
  agentHookServer.subscribeEnrichedStatus((enriched) => {
    const payload = projectPluginAgentStatusChangedPayload(enriched, store)
    if (payload) {
      forwardAgentStatus(payload, enriched.terminalHandle)
    }
  })
  watchPluginWorkspaceContext({
    delegate: pluginDelegate,
    events: pluginService,
    onSessionWritten: (listener) => store.onWorkspaceSessionWritten(listener),
    onStateWritten: (listener) => store.onStateWritten(listener)
  })
  runtime.onWorktreeLifecycle(emitPluginWorktreeLifecycle)
}
