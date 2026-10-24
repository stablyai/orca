import type { PluginEventName } from '../../shared/plugins/manifest/plugin-manifest'
import {
  capabilityKinds,
  type PluginCapabilityKind
} from '../../shared/plugins/plugin-capabilities'
import type {
  PluginActivationState,
  PluginConsentLists
} from '../../shared/plugins/approval/plugin-consent-state'
import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'
import { createPluginExtensionRegistry } from '../../shared/plugins/plugin-extension-registry'
import {
  discoverPlugins,
  getPluginsDataDir,
  getUserPluginsDir,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import { PluginAuditLog } from './plugin-audit-log'
import { executePluginHostCallRequest } from './workers/plugin-host-call-adapter'
import { PluginContentVerifier } from './plugin-content-integrity'
import {
  bindPluginHostServices,
  type PluginRuntimeDelegate
} from './workers/plugin-host-service-bindings'
import { PluginPanelController } from './panels/plugin-panel-controller'
import { PluginWorkerController } from './workers/plugin-worker-controller'
import { PluginServiceHousekeeping } from './plugin-service-housekeeping'
import {
  collectApprovedWorkerSpecs,
  isApprovedWorkerSpec
} from './workers/plugin-worker-reconciliation'
import type { PluginRunState } from './workers/plugin-supervisor'
import {
  isPluginApproved,
  livePluginActivationState,
  pluginPolicyBlockError,
  snapshotPluginConsentLists
} from './plugin-activation-policy'
import { PluginContentPackRegistry } from './contributions/plugin-content-pack-registry'
import type { PluginServiceOptions } from './plugin-service-options'
import type { PluginChangeEvent } from '../../shared/plugins/plugin-change-event'
import { waitForPluginRefreshSettlement } from './plugin-refresh-settlement'
import { assertPluginWorkerCommand } from './plugin-command-invocation'
import { deliverPluginEvent } from './plugin-event-delivery'
import { PluginInstallationState } from './installation/plugin-installation-state'

export class PluginService {
  readonly options: PluginServiceOptions
  private readonly registry = createPluginExtensionRegistry()
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
    const resolveApproved = (pluginKey: string) => {
      const plugin = this.findValidPlugin(pluginKey)
      return plugin && this.canStartPluginWork(plugin) ? plugin : null
    }
    this.panels = new PluginPanelController({
      resolveApprovedPlugin: resolveApproved,
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
      isCurrentApproved: (spec) => isApprovedWorkerSpec(spec, resolveApproved(spec.pluginKey)),
      invokeCommand: (pluginKey, commandId, args) => this.invokeCommand(pluginKey, commandId, args),
      executeHostCall: (pluginKey, method, params) =>
        this.executeHostCall(pluginKey, method, params, { viaPanel: false }),
      log: (pluginKey) => this.installed.logs.capture(pluginKey),
      onStateChanged: () => this.notifyChanged(false)
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
    // Client reads must wait for rollback-based content validation to settle.
    await waitForPluginRefreshSettlement(() => this.refreshChain)
  }

  refresh(): Promise<void> {
    // Snapshot settings at request time so a quick off→on sequence still
    // processes the off transition and revokes old workers/panel sessions.
    const enabled = this.options.isPluginSystemEnabled()
    const devPaths = this.options.getDevPluginPaths()
    const consentLists = snapshotPluginConsentLists(this.options)
    return this.enqueue(() => this.performRefresh(enabled, devPaths, consentLists))
  }

  /** Serializes discovery, removal, and reconciliation so none sees another's partial state. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const queued = this.refreshChain.then(work)
    this.refreshChain = queued.catch(() => undefined)
    return queued
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
    await this.workerController.reconcile(nextSpecs, (key) => this.findValidPlugin(key))
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

  activationState(plugin: ValidDiscoveredPlugin): PluginActivationState {
    return livePluginActivationState(this.options, plugin)
  }

  private canStartPluginWork(plugin: ValidDiscoveredPlugin): boolean {
    return !this.installed.isRemoving(plugin) && this.isRuntimeApproved(plugin)
  }

  private isRuntimeApproved(plugin: ValidDiscoveredPlugin): boolean {
    return (
      this.contentPacksReady &&
      this.activationState(plugin) === 'approved' &&
      !this.contentPacks.error(plugin.pluginKey) &&
      !pluginPolicyBlockError(this.options, plugin.pluginKey, plugin)
    )
  }

  workerState(pluginKey: string): { state: PluginRunState; restarts: number } {
    return this.workerController.state(pluginKey)
  }

  activationError(pluginKey: string): string | null {
    return (
      pluginPolicyBlockError(this.options, pluginKey, this.findValidPlugin(pluginKey)) ??
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
              pluginsDataDir: getPluginsDataDir(this.options.userDataPath)
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
      workerController: this.workerController,
      isRuntimeApproved: (plugin) => this.canStartPluginWork(plugin),
      grantedCapabilities: (pluginKey) => this.getGrantedCapabilities(pluginKey),
      logWarning: (pluginKey) => this.installed.captureLog(pluginKey, 'warn')
    })
  }

  removePlugin(pluginKey: string, remove: () => Promise<void>): Promise<void> {
    return this.enqueue(() => this.installed.remove(pluginKey, remove))
  }

  async deactivatePlugin(pluginKey: string): Promise<void> {
    await this.workerController.deactivate(pluginKey)
    this.notifyChanged(false)
  }

  /** Reconciles live workers and client projections after consent or
   * enablement changes without re-reading plugin files or starting workers. */
  async reconcileActivationState(): Promise<void> {
    return this.enqueue(() => this.performActivationStateReconciliation())
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
