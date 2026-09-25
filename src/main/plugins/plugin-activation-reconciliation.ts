import type { PluginConsentLists } from '../../shared/plugins/plugin-consent-state'
import { discoverPlugins, getUserPluginsDir, type ValidDiscoveredPlugin } from './plugin-discovery'
import { isPluginApproved } from './plugin-activation-policy'
import { collectApprovedWorkerSpecs } from './plugin-worker-reconciliation'
import type { PluginContentVerifier } from './plugin-content-integrity'
import type { PluginContentPackRegistry } from './plugin-content-pack-registry'
import type { PluginInstallationState } from './plugin-installation-state'
import type { PluginPanelController } from './plugin-panel-controller'
import type { PluginServiceHousekeeping } from './plugin-service-housekeeping'
import type { PluginServiceOptions } from './plugin-service-options'
import type { PluginWorkerController } from './plugin-worker-controller'

export type PluginActivationReconciliationOptions = {
  options: PluginServiceOptions
  contentVerifier: PluginContentVerifier
  contentPacks: PluginContentPackRegistry
  panels: PluginPanelController
  workerController: PluginWorkerController
  installed: PluginInstallationState
  housekeeping: PluginServiceHousekeeping
  isDisposed: () => boolean
  isApproved: (plugin: ValidDiscoveredPlugin) => boolean
  isRuntimeApproved: (plugin: ValidDiscoveredPlugin) => boolean
  notifyChanged: (contentPacksChanged: boolean) => void
  requestRefresh: () => void
}

/**
 * Brings content packs, workers and housekeeping in line with what consent
 * currently allows — either after re-reading the plugin directories, or from
 * the discovery already in hand. Owns the content-pack readiness flag because
 * both passes invalidate it while they run.
 */
export class PluginActivationReconciliation {
  private contentPacksReady = false

  constructor(private readonly deps: PluginActivationReconciliationOptions) {}

  isContentPacksReady(): boolean {
    return this.contentPacksReady
  }

  /** Re-reads the plugin directories, then reconciles everything downstream. */
  async refresh(
    enabled: boolean,
    devPaths: string[],
    consentLists: PluginConsentLists
  ): Promise<void> {
    const deps = this.deps
    if (deps.isDisposed()) {
      return
    }
    this.contentPacksReady = false
    deps.contentVerifier.clear()
    if (!enabled) {
      deps.panels.revokeAll()
    }
    const next = enabled
      ? await discoverPlugins({
          pluginsDir: getUserPluginsDir(deps.options.userDataPath),
          devPluginPaths: devPaths,
          hostVersion: deps.options.hostVersion
        })
      : []
    if (deps.isDisposed()) {
      return
    }
    // Publish identity before shutdown so triggers cannot restart old code.
    deps.installed.discovered = next
    await deps.contentPacks.reconcile(
      next,
      (plugin) => isPluginApproved(enabled, plugin, consentLists),
      deps.options.getKeybindings?.()
    )
    this.contentPacksReady = true
    const nextSpecs = collectApprovedWorkerSpecs(next, (plugin) => deps.isRuntimeApproved(plugin))
    // Notify before slow shutdown so feature-off unmounts panels immediately.
    deps.notifyChanged(true)
    await deps.workerController.reconcile(nextSpecs)
    if (deps.isDisposed()) {
      return
    }
    deps.housekeeping.sync({
      enabled,
      devPaths,
      reapIdle: () => deps.workerController.reapIdle(),
      refresh: () => deps.requestRefresh()
    })
    deps.notifyChanged(false)
  }

  /** Reconciles live workers and client projections after consent or
   * enablement changes without re-reading plugin files or starting workers. */
  async reapplyActivationState(): Promise<void> {
    const deps = this.deps
    this.contentPacksReady = false
    await deps.contentPacks.reconcile(
      deps.installed.discovered,
      (plugin) => deps.isApproved(plugin),
      deps.options.getKeybindings?.()
    )
    this.contentPacksReady = true
    const nextSpecs = collectApprovedWorkerSpecs(deps.installed.discovered, (plugin) =>
      deps.isRuntimeApproved(plugin)
    )
    await deps.workerController.reconcile(nextSpecs)
    deps.notifyChanged(true)
  }
}
