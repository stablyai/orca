import type { PluginEventName } from '../../shared/plugins/plugin-manifest'
import {
  capabilityKinds,
  type PluginCapabilityKind
} from '../../shared/plugins/plugin-capabilities'
import {
  getPluginActivationState,
  type PluginConsentLists
} from '../../shared/plugins/plugin-consent-state'
import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'
import { createPluginExtensionRegistry } from '../../shared/plugins/plugin-extension-registry'
import {
  discoverPlugins,
  getPluginsDataDir,
  getUserPluginsDir,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import { PluginEventBus } from './plugin-event-bus'
import { PluginAuditLog } from './plugin-audit-log'
import { executePluginHostCallRequest } from './plugin-host-call-adapter'
import { PluginContentVerifier } from './plugin-content-integrity'
import { bindPluginHostServices, type PluginRuntimeDelegate } from './plugin-host-service-bindings'
import { PluginPanelController } from './plugin-panel-controller'
import { PluginWorkerController } from './plugin-worker-controller'
import { PluginServiceHousekeeping } from './plugin-service-housekeeping'
import { collectApprovedWorkerSpecs } from './plugin-worker-reconciliation'
import type { PluginRunState } from './plugin-supervisor'
import { isPluginApproved, snapshotPluginConsentLists } from './plugin-activation-policy'
import { PluginContentPackRegistry } from './plugin-content-pack-registry'
import type { PluginServiceOptions } from './plugin-service-options'
import type { PluginChangeEvent } from '../../shared/plugins/plugin-change-event'
import { waitForPluginRefreshSettlement } from './plugin-refresh-settlement'
import { assertPluginWorkerCommand } from './plugin-command-invocation'
import { deliverPluginEvent } from './plugin-event-delivery'
import { PluginInstallationState } from './plugin-installation-state'

export type { PluginRuntimeDelegate } from './plugin-host-service-bindings'
export type { PluginLogLine } from './plugin-log-buffer'
export type { PluginServiceOptions } from './plugin-service-options'

export class PluginService {
  readonly options: PluginServiceOptions
  private readonly registry = createPluginExtensionRegistry()
  private readonly eventBus = new PluginEventBus()
  private readonly audit: PluginAuditLog
  private readonly workerController: PluginWorkerController
  private readonly contentVerifier = new PluginContentVerifier()
  readonly contentPacks: PluginContentPackRegistry
  readonly panels: PluginPanelController
  private readonly changeListeners = new Set<(event: PluginChangeEvent) => void>()
  private readonly housekeeping = new PluginServiceHousekeeping()
  private runtimeDelegate: PluginRuntimeDelegate | null = null
  private initPromise: Promise<void> | null = null
  private refreshChain: Promise<void> = Promise.resolve()
  private contentPacksReady = false
  private disposed = false
  private readonly installed = new PluginInstallationState({
    pluginsDir: () => getUserPluginsDir(this.options.userDataPath),
    deactivate: (pluginKey) => this.workerController.deactivate(pluginKey),
    notifyChanged: () => this.notifyChanged(false)
  })

  constructor(options: PluginServiceOptions) {
    this.options = options
    this.contentPacks = new PluginContentPackRegistry(this.contentVerifier, (pluginKey) =>
      Boolean(this.options.getPluginKillListEntry?.(pluginKey))
    )
    this.audit = new PluginAuditLog(getPluginsDataDir(options.userDataPath))
    this.panels = new PluginPanelController({
      resolveApprovedPlugin: (pluginKey) => {
        const plugin = this.findValidPlugin(pluginKey)
        return plugin && this.canStartPluginWork(plugin) ? plugin : null
      },
      contentVerifier: this.contentVerifier,
      executeHostCall: (pluginKey, method, params) =>
        this.executeHostCall(pluginKey, method, params, { viaPanel: true }),
      log: (pluginKey) => this.installed.captureLog(pluginKey, 'error')
    })
    this.workerController = new PluginWorkerController({
      entryPath: options.hostEntryPath ?? '',
      maxActive: options.maxActiveWorkers,
      idleReapMs: options.idleReapMs,
      workerFactory: options.workerFactory,
      registry: this.registry,
      contentVerifier: this.contentVerifier,
      capabilities: (pluginKey) => this.getGrantedCapabilities(pluginKey),
      isCurrentApproved: (plugin) =>
        this.findValidPlugin(plugin.pluginKey) === plugin && this.canStartPluginWork(plugin),
      invokeCommand: (pluginKey, commandId, args) => this.invokeCommand(pluginKey, commandId, args),
      executeHostCall: (pluginKey, method, params) =>
        this.executeHostCall(pluginKey, method, params, { viaPanel: false }),
      log: (pluginKey) => this.installed.logs.capture(pluginKey),
      onStateChanged: () => this.notifyChanged(false),
      onWorkerGone: (pluginKey) => this.eventBus.clear(pluginKey)
    })
  }

  setRuntimeDelegate(delegate: PluginRuntimeDelegate | null): void {
    this.runtimeDelegate = delegate
  }

  onChanged(listener: (event: PluginChangeEvent) => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  private notifyChanged(contentPacksChanged: boolean): void {
    for (const listener of this.changeListeners) {
      listener({ contentPacksChanged })
    }
  }

  async initialize(): Promise<void> {
    this.initPromise ??= this.refresh()
    return this.initPromise
  }

  async whenReady(): Promise<void> {
    await (this.initPromise ?? Promise.resolve()).catch(() => undefined)
    // Client reads wait for the complete transaction so rollback-based content
    // validation cannot expose a partially activated plugin between passes.
    await waitForPluginRefreshSettlement(() => this.refreshChain)
  }

  refresh(): Promise<void> {
    // Snapshot settings at request time so a quick off→on sequence still
    // processes the off transition and revokes old workers/panel sessions.
    const enabled = this.options.isPluginSystemEnabled()
    const devPaths = this.options.getDevPluginPaths()
    const consentLists = snapshotPluginConsentLists(this.options)
    const refresh = this.refreshChain.then(() =>
      this.performRefresh(enabled, devPaths, consentLists)
    )
    this.refreshChain = refresh.catch(() => undefined)
    return refresh
  }

  private async performRefresh(
    enabled: boolean,
    devPaths: string[],
    consentLists: PluginConsentLists
  ): Promise<void> {
    if (this.disposed) {
      return
    }
    this.contentPacksReady = false
    this.contentVerifier.clear()
    if (!enabled) {
      this.panels.revokeAll()
    }
    const next = enabled
      ? await discoverPlugins({
          pluginsDir: getUserPluginsDir(this.options.userDataPath),
          devPluginPaths: devPaths,
          hostVersion: this.options.hostVersion
        })
      : []
    if (this.disposed) {
      return
    }
    // Publish identity before shutdown so triggers cannot restart old code.
    this.installed.discovered = next
    await this.contentPacks.reconcile(
      next,
      (plugin) => isPluginApproved(enabled, plugin, consentLists),
      this.options.getKeybindings?.()
    )
    this.contentPacksReady = true
    const nextSpecs = collectApprovedWorkerSpecs(next, (plugin) => this.isRuntimeApproved(plugin))
    // Notify before slow shutdown so feature-off unmounts panels immediately.
    this.notifyChanged(true)
    await this.workerController.reconcile(nextSpecs)
    if (this.disposed) {
      return
    }
    this.housekeeping.sync({
      enabled,
      devPaths,
      reapIdle: () => this.workerController.reapIdle(),
      refresh: () => void this.refresh()
    })
    this.notifyChanged(false)
  }

  getDiscovered(): readonly DiscoveredPlugin[] {
    return this.installed.discovered
  }

  getLogs(pluginKey: string) {
    return this.installed.logs.get(pluginKey)
  }

  findValidPlugin(pluginKey: string): ValidDiscoveredPlugin | null {
    return this.installed.findValid(pluginKey)
  }

  activationState(plugin: ValidDiscoveredPlugin): ReturnType<typeof getPluginActivationState> {
    // The feature flag is an authority boundary, not only a discovery hint:
    // callers fail closed immediately even before async reconciliation ends.
    if (!this.options.isPluginSystemEnabled()) {
      return 'disabled'
    }
    return getPluginActivationState(plugin.pluginKey, plugin.consentFingerprint, {
      pluginConsents: this.options.getPluginConsents(),
      disabledPlugins: this.options.getDisabledPlugins()
    })
  }

  private canStartPluginWork(plugin: ValidDiscoveredPlugin): boolean {
    return !this.installed.isRemoving(plugin) && this.isRuntimeApproved(plugin)
  }

  private isRuntimeApproved(plugin: ValidDiscoveredPlugin): boolean {
    return (
      this.contentPacksReady &&
      this.activationState(plugin) === 'approved' &&
      !this.contentPacks.error(plugin.pluginKey) &&
      !this.options.getPluginKillListEntry?.(plugin.pluginKey)
    )
  }

  workerState(pluginKey: string): { state: PluginRunState; restarts: number } {
    return this.workerController.state(pluginKey)
  }

  activationError(pluginKey: string): string | null {
    const blocked = this.options.getPluginKillListEntry?.(pluginKey)
    return (
      (blocked ? `Blocked by Orca's plugin safety list: ${blocked.reason}` : null) ??
      this.contentPacks.error(pluginKey) ??
      this.workerController.activationError(pluginKey)
    )
  }

  /** Consented capability kinds for an approved plugin; null otherwise so
   *  callers deny uniformly (no probe-able distinction). */
  getGrantedCapabilities(pluginKey: string): PluginCapabilityKind[] | null {
    const plugin = this.findValidPlugin(pluginKey)
    return plugin && this.isRuntimeApproved(plugin)
      ? capabilityKinds(plugin.manifest.capabilities)
      : null
  }

  /** Host API chokepoint for both transports (worker fork IPC + panel
   *  bridge); serve RPC reuses it through the same entry points. */
  async executeHostCall(
    pluginKey: string,
    method: string,
    params: unknown,
    options: { viaPanel: boolean }
  ): Promise<PluginPanelActionOutcome> {
    return executePluginHostCallRequest({
      pluginKey,
      request: { method, params },
      viaPanel: options.viaPanel,
      resolvePolicy: (boundPluginKey) => ({
        grantedCapabilities: this.getGrantedCapabilities(boundPluginKey),
        services: this.runtimeDelegate
          ? bindPluginHostServices({
              delegate: this.runtimeDelegate,
              pluginsDataDir: getPluginsDataDir(this.options.userDataPath),
              subscribeEvents: (key, events) => this.eventBus.subscribe(key, events)
            })
          : null,
        audit: this.audit
      })
    })
  }

  async invokeCommand(pluginKey: string, commandId: string, args?: unknown): Promise<unknown> {
    const plugin = this.findValidPlugin(pluginKey)
    if (!plugin || !this.canStartPluginWork(plugin)) {
      throw new Error(`plugin ${pluginKey} is not enabled`)
    }
    assertPluginWorkerCommand(plugin, commandId)
    const handle = await this.workerController.ensure(plugin)
    if (!handle.commands.includes(commandId)) {
      throw new Error(`plugin ${pluginKey} registered no handler for ${commandId}`)
    }
    return handle.invokeCommand(commandId, args)
  }

  emitEvent(event: PluginEventName, payload: unknown): void {
    if (!this.options.isPluginSystemEnabled() || this.disposed) {
      return
    }
    deliverPluginEvent({
      event,
      payload,
      plugins: this.installed.discovered,
      eventBus: this.eventBus,
      workerController: this.workerController,
      isRuntimeApproved: (plugin) => this.canStartPluginWork(plugin),
      logWarning: (pluginKey) => this.installed.captureLog(pluginKey, 'warn')
    })
  }

  removePlugin(pluginKey: string, remove: () => Promise<void>): Promise<void> {
    const removal = this.refreshChain.then(() => this.installed.remove(pluginKey, remove))
    this.refreshChain = removal.catch(() => undefined)
    return removal
  }

  async deactivatePlugin(pluginKey: string): Promise<void> {
    await this.workerController.deactivate(pluginKey)
    this.notifyChanged(false)
  }

  /** Reconciles live workers and client projections after consent or
   * enablement changes without re-reading plugin files or starting workers. */
  async reconcileActivationState(): Promise<void> {
    const reconcile = this.refreshChain.then(() => this.performActivationStateReconciliation())
    this.refreshChain = reconcile.catch(() => undefined)
    return reconcile
  }

  private async performActivationStateReconciliation(): Promise<void> {
    this.contentPacksReady = false
    await this.contentPacks.reconcile(
      this.installed.discovered,
      (plugin) => this.activationState(plugin) === 'approved',
      this.options.getKeybindings?.()
    )
    this.contentPacksReady = true
    const nextSpecs = collectApprovedWorkerSpecs(this.installed.discovered, (plugin) =>
      this.isRuntimeApproved(plugin)
    )
    await this.workerController.reconcile(nextSpecs)
    this.notifyChanged(true)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.housekeeping.dispose()
    this.panels.dispose()
    await this.refreshChain.catch(() => undefined)
    await this.workerController.dispose()
    await this.audit.flush()
  }
}
