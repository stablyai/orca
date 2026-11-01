import type { PluginEventName } from '../../shared/plugins/manifest/plugin-manifest'
import {
  capabilityKinds,
  type PluginCapabilityKind
} from '../../shared/plugins/capabilities/plugin-capabilities'
import type {
  PluginActivationState,
  PluginConsentLists
} from '../../shared/plugins/approval/plugin-consent-state'
import {
  discoverPlugins,
  getPluginsDataDir,
  getUserPluginsDir,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import { PluginAuditLog, type PluginAuditEntry } from './plugin-audit-log'
import { PluginContentVerifier } from './plugin-content-integrity'
import type { PluginRuntimeDelegate } from './workers/plugin-host-service-bindings'
import {
  createPluginServiceHostCall,
  pluginPanelBridgeServices,
  resolvePluginServiceHostCallPolicy,
  type PluginServiceHostCall
} from './plugin-service-host-call'
import { PluginPanelBridge } from './panels/plugin-panel-bridge'
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
import type { PluginChangeEvent } from '../../shared/plugins/events/plugin-change-event'
import { waitForPluginRefreshSettlement } from './plugin-refresh-settlement'
import { invokePluginWorkerCommand } from './plugin-command-invocation'
import { deliverPluginEvent, pluginWorkersWantEvent } from './plugin-event-delivery'
import type { PluginEventDeliveryContext } from './plugin-event-delivery'
import { PluginInstallationState } from './installation/plugin-installation-state'

export class PluginService {
  readonly options: PluginServiceOptions
  private readonly audit: PluginAuditLog
  private readonly workerController: PluginWorkerController
  private readonly contentVerifier = new PluginContentVerifier()
  readonly contentPacks: PluginContentPackRegistry
  readonly panels: PluginPanelController
  readonly panelBridge: PluginPanelBridge
  private readonly hostCall: PluginServiceHostCall
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
    const resolveApproved = (pluginKey: string, allowRefreshPause = false) =>
      this.findApprovedPlugin(pluginKey, allowRefreshPause)
    this.panelBridge = new PluginPanelBridge({
      findApprovedPlugin: (pluginKey) => resolveApproved(pluginKey),
      grantedCapabilities: (pluginKey) => this.getGrantedCapabilities(pluginKey),
      ensureWorker: (plugin) => this.workerController.ensure(plugin),
      runningWorker: (pluginKey) => this.workerController.runningHandle(pluginKey),
      log: (pluginKey) => this.installed.captureLog(pluginKey, 'warn'),
      runtimeDelegate: () => this.runtimeDelegate
    })
    this.hostCall = createPluginServiceHostCall((pluginKey, caller) =>
      resolvePluginServiceHostCallPolicy({
        pluginKey,
        caller,
        findApprovedPlugin: resolveApproved,
        runtimeDelegate: this.runtimeDelegate,
        pluginsDataDir: getPluginsDataDir(this.options.userDataPath),
        desktop: this.options.getDesktopFrameServices?.(),
        panels: pluginPanelBridgeServices(this.panelBridge),
        audit: this.audit,
        log: (pluginKey) => this.installed.captureLog(pluginKey, 'info')
      })
    )
    this.panels = new PluginPanelController({
      resolveApprovedPlugin: resolveApproved,
      contentVerifier: this.contentVerifier,
      executeHostCall: (pluginKey, method, params, surface, caller) =>
        this.executeHostCall(pluginKey, method, params, surface, caller),
      log: (pluginKey) => this.installed.captureLog(pluginKey, 'error'),
      onSessionClosed: (panelId) => this.panelBridge.close(panelId)
    })
    this.workerController = new PluginWorkerController({
      entryPath: options.hostEntryPath ?? '',
      maxActive: options.maxActiveWorkers,
      idleReapMs: options.idleReapMs,
      workerFactory: options.workerFactory,
      contentVerifier: this.contentVerifier,
      capabilities: (pluginKey) => this.getGrantedCapabilities(pluginKey),
      isCurrentApproved: (spec) => isApprovedWorkerSpec(spec, resolveApproved(spec.pluginKey)),
      isApprovalKept: (spec) => isApprovedWorkerSpec(spec, resolveApproved(spec.pluginKey, true)),
      executeHostCall: (pluginKey, method, params) =>
        this.executeHostCall(pluginKey, method, params, 'worker'),
      onPanelPost: (pluginKey, post) => this.panelBridge.onWorkerPost(pluginKey, post),
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
    // Snapshot off→on transitions so reconciliation cannot miss worker/panel revocation.
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

  recordApprovalAudit(entry: PluginAuditEntry): Promise<void> {
    return this.audit.record(entry)
  }

  readonly getLogs = (pluginKey: string) => this.installed.logs.get(pluginKey)

  readonly getLogsSince = (key: string, cursor?: string) => this.installed.logs.since(key, cursor)

  /** A log writer for one plugin that goes inert once the plugin is removed. */
  readonly captureLog = (pluginKey: string) => this.installed.logs.capture(pluginKey)

  findValidPlugin(pluginKey: string): ValidDiscoveredPlugin | null {
    return this.installed.findValid(pluginKey)
  }

  /** Enabled, consented and not being removed: what may open frames or hand out its files. */
  findApprovedPlugin(pluginKey: string, allowRefreshPause = false): ValidDiscoveredPlugin | null {
    const plugin = this.findValidPlugin(pluginKey)
    return plugin && this.canStartPluginWork(plugin, allowRefreshPause) ? plugin : null
  }

  activationState(plugin: ValidDiscoveredPlugin): PluginActivationState {
    return livePluginActivationState(this.options, plugin)
  }

  private canStartPluginWork(plugin: ValidDiscoveredPlugin, allowRefreshPause = false): boolean {
    return !this.installed.isRemoving(plugin) && this.isRuntimeApproved(plugin, allowRefreshPause)
  }

  private isRuntimeApproved(plugin: ValidDiscoveredPlugin, allowRefreshPause = false): boolean {
    return (
      (allowRefreshPause || this.contentPacksReady) &&
      this.activationState(plugin) === 'approved' &&
      !this.contentPacks.error(plugin.pluginKey) &&
      !pluginPolicyBlockError(this.options, plugin.pluginKey)
    )
  }

  workerState(pluginKey: string): { state: PluginRunState; restarts: number } {
    return this.workerController.state(pluginKey)
  }

  activationError(pluginKey: string): string | null {
    return (
      pluginPolicyBlockError(this.options, pluginKey) ??
      this.contentPacks.error(pluginKey) ??
      this.workerController.activationError(pluginKey)
    )
  }

  /** Null uniformly denies unapproved or departing plugins without exposing why. */
  getGrantedCapabilities(pluginKey: string): PluginCapabilityKind[] | null {
    const plugin = this.findApprovedPlugin(pluginKey)
    return plugin ? capabilityKinds(plugin.manifest.capabilities) : null
  }

  executeHostCall(...args: Parameters<PluginServiceHostCall>): ReturnType<PluginServiceHostCall> {
    return this.hostCall(...args)
  }

  invokeCommand(pluginKey: string, commandId: string, args?: unknown): Promise<unknown> {
    const plugin = this.findApprovedPlugin(pluginKey)
    return invokePluginWorkerCommand(pluginKey, plugin, this.workerController, commandId, args)
  }

  wantsEvent(event: PluginEventName): boolean {
    return (
      this.panelBridge.hasSubscribers(event) ||
      pluginWorkersWantEvent(event, this.installed.discovered, (p) => this.canStartPluginWork(p))
    )
  }

  emitEvent(event: PluginEventName, payload: unknown): void {
    if (this.options.isPluginSystemEnabled() && !this.disposed) {
      deliverPluginEvent({ event, payload, ...this.eventDelivery })
      this.panelBridge.publishEvent(event, payload)
    }
  }

  /** The real event path; `orca plugin dev emit` reuses it for one development plugin. */
  readonly eventDelivery: PluginEventDeliveryContext = {
    plugins: () => this.installed.discovered,
    ensureWorker: (plugin) => this.workerController.ensure(plugin),
    isRuntimeApproved: (plugin) => this.canStartPluginWork(plugin),
    grantedCapabilities: (pluginKey) => this.getGrantedCapabilities(pluginKey),
    logWarning: (pluginKey) => this.installed.captureLog(pluginKey, 'warn')
  }

  removePlugin(pluginKey: string, remove: () => Promise<void>): Promise<void> {
    return this.enqueue(() => this.installed.remove(pluginKey, remove))
  }

  async deactivatePlugin(pluginKey: string): Promise<void> {
    await this.workerController.deactivate(pluginKey)
    this.notifyChanged(false)
  }

  /** Reconcile consent/enablement without rereading files or starting workers. */
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
    this.panelBridge.dispose()
    // Why stop workers first: a refresh may be waiting on a worker slot only shutdown releases.
    await Promise.all([this.workerController.dispose(), this.refreshChain.catch(() => undefined)])
    await this.audit.flush()
  }
}
