import type { PluginEventName } from '../../shared/plugins/manifest/plugin-manifest'
import {
  capabilityKinds,
  type PluginCapabilityKind
} from '../../shared/plugins/capabilities/plugin-capabilities'
import type {
  PluginActivationState,
  PluginConsentLists
} from '../../shared/plugins/approval/plugin-consent-state'
import type {
  PluginHostCallOutcome,
  PluginSurface
} from '../../shared/plugins/frames/plugin-protocol'
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
import type { PluginChangeEvent } from '../../shared/plugins/events/plugin-change-event'
import { waitForPluginRefreshSettlement } from './plugin-refresh-settlement'
import { assertPluginWorkerCommand } from './plugin-command-invocation'
import { deliverPluginEvent } from './plugin-event-delivery'
import { PluginInstallationState } from './installation/plugin-installation-state'

export class PluginService {
  readonly options: PluginServiceOptions
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
    const resolveApproved = (pluginKey: string, allowRefreshPause = false) =>
      this.findApprovedPlugin(pluginKey, allowRefreshPause)
    this.panels = new PluginPanelController({
      resolveApprovedPlugin: resolveApproved,
      contentVerifier: this.contentVerifier,
      executeHostCall: (pluginKey, method, params, surface) =>
        this.executeHostCall(pluginKey, method, params, surface),
      log: (pluginKey) => this.installed.captureLog(pluginKey, 'error')
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

  /** Null uniformly denies unapproved plugins without exposing why. */
  getGrantedCapabilities(pluginKey: string): PluginCapabilityKind[] | null {
    const plugin = this.findValidPlugin(pluginKey)
    return plugin && this.isRuntimeApproved(plugin)
      ? capabilityKinds(plugin.manifest.capabilities)
      : null
  }

  async executeHostCall(
    pluginKey: string,
    method: string,
    params: unknown,
    surface: PluginSurface
  ): Promise<PluginHostCallOutcome> {
    return executePluginHostCallRequest({
      pluginKey,
      request: { method, params },
      surface,
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
    // Why stop workers first: a refresh may be waiting on a worker slot only shutdown releases.
    await Promise.all([this.workerController.dispose(), this.refreshChain.catch(() => undefined)])
    await this.audit.flush()
  }
}
