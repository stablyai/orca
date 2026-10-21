/**
 * WSL distros as hosts (WSL-via-orcad C7): add and remove them, persist what each connection
 * reports, and connect only for the user. A stopped distro boots on an explicit add or connect,
 * or while a project or terminal the user has open needs it; never for background work.
 */
import { errorMessage } from '../../shared/error-message'
import { removeWslHostEnvironment } from '../../shared/runtime-environment-wsl-host-store'
import {
  readWslHostDeployments,
  type WslHostDeploymentRecord
} from '../../shared/wsl-host-deployment-store'
import type {
  WslHostAddResult,
  WslHostDistro,
  WslHostServerStop,
  WslHostStatus
} from '../../shared/wsl-host-types'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import { persistWslHostConnection, toWslHostStatus } from './wsl-host-connection-record'
import {
  sameWslDistro,
  wslHostNotConnectedMessage,
  WSL_HOST_REMOVING_MESSAGE,
  wslHostRunRefusal
} from './wsl-host-add-admission'
import type { WslOrcadConnection } from './wsl-orcad-connection'
import { registerWslHost } from './wsl-host-registration'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'

/** The WSL side the service drives: C3 holder, C5 connections, C6 liveness (or an e2e fake). */
export type WslHostConnector = {
  listDistros(): Promise<WslHostDistroCandidate[]>
  /** Runs in the distro, so it boots a stopped one: only after the user chose to. */
  readOrcadPublicKey(distro: string): Promise<string | null>
  /** User-initiated; may boot the distro. `force` takes an update live terminals deferred. */
  connect(distro: string, options?: { force?: boolean }): Promise<WslOrcadConnection>
  get(distro: string): WslOrcadConnection | null
  /** Checks the paired server without starting a stopped or unconfirmed distro. */
  isReachable(distro: string, environmentId: string): Promise<boolean>
  disconnect(distro: string): Promise<void>
  /** Ends the host's terminals, orcad and its terminal daemon; never boots a stopped distro. */
  stopServer(distro: string, environmentId: string): Promise<WslHostServerStop>
  releaseHolder(distro: string): Promise<void>
  adoptHolders(): Promise<void>
  dispose(): Promise<void>
}

export type WslHostServiceDependencies = {
  userDataPath: () => string
  isEnabled: () => boolean
  /** Whether this build ships the orcad template a WSL host deploys from. */
  hasServerFiles: () => boolean
  publish: (status: WslHostStatus) => void
  /** The environment's pairing changed: transports that authenticate with the old one retire. */
  pairingChanged: (environmentId: string) => void
  /** A connection came up: verify the server now rather than on the status owner's backoff. */
  ready: (environmentId: string) => void
  removed: (environmentId: string) => Promise<void> | void
}

export class WslHostService {
  private connector: WslHostConnector | null = null
  private readonly statuses = new Map<string, WslHostStatus>()
  private readonly adding = new Map<string, Promise<WslHostAddResult>>()
  private visible = new Set<string>()
  private readonly removing = new Set<string>()
  // Bumped on disable so an Add that started before it cannot finish as a ready host.
  private disableGeneration = 0
  private readonly statusListeners = new Set<() => void>()

  constructor(private readonly deps: WslHostServiceDependencies) {}

  /** Two-phase so the connector's `onChange` can call back into this service. */
  attach(connector: WslHostConnector): void {
    this.connector = connector
  }

  private get wsl(): WslHostConnector {
    if (!this.connector) {
      throw new Error('WSL hosts are not available on this computer.')
    }
    return this.connector
  }

  /** C5's `onChange`: persist what moved, then tell the UI. */
  handleConnectionChange(
    distro: string,
    connection: WslOrcadConnection | null,
    status: WslOrcadConnectionStatus
  ): void {
    const record = this.recordForDistro(distro)
    if (!record) {
      return
    }
    if (connection && persistWslHostConnection(this.deps.userDataPath(), record, connection)) {
      this.deps.pairingChanged(record.environmentId)
    }
    this.setStatus(record, status, connection)
    if (status.state === 'ready' && connection) {
      this.deps.ready(record.environmentId)
    }
  }

  getStatuses(): WslHostStatus[] {
    return [...this.statuses.values()]
  }

  /** Hears every change to what `getStatuses` returns. */
  onStatusesChanged(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  private notifyStatusesChanged(): void {
    for (const listener of this.statusListeners) {
      listener()
    }
  }

  async listDistros(): Promise<WslHostDistro[]> {
    const records = this.records()
    const candidates = await this.wsl.listDistros()
    return candidates.map(({ id: _id, ...distro }) => ({
      ...distro,
      environmentId:
        records.find((record) => sameWslDistro(record.distro, distro.name))?.environmentId ?? null
    }))
  }

  add(args: { distro: string; startIfStopped?: boolean }): Promise<WslHostAddResult> {
    const key = wslDistroHolderKey(args.distro)
    const pending = this.adding.get(key)
    if (pending) {
      return pending
    }
    const operation = registerWslHost(
      {
        deps: this.deps,
        wsl: () => this.wsl,
        disableGeneration: () => this.disableGeneration,
        recordForDistro: (distro) => this.recordForDistro(distro),
        recordForEnvironment: (environmentId) => this.recordForEnvironment(environmentId),
        setReady: (record, connection) =>
          this.setStatus(record, { state: 'ready', census: null }, connection)
      },
      args
    ).finally(() => this.adding.delete(key))
    this.adding.set(key, operation)
    return operation
  }

  async remove(environmentId: string): Promise<WslHostServerStop> {
    const record = this.recordForEnvironment(environmentId)
    if (!record) {
      throw new Error('This server is not a WSL host.')
    }
    // First: nothing may reconnect it while it is being stopped (open work, liveness, calls).
    this.removing.add(environmentId)
    const connector = this.connector
    let serverStop: WslHostServerStop = { stopped: true }
    try {
      if (connector) {
        serverStop = await connector
          .stopServer(record.distro, environmentId)
          .catch((error: unknown) => ({ stopped: false, reason: errorMessage(error) }))
        await connector.disconnect(record.distro)
        // Without its holder the distro idles out.
        await connector.releaseHolder(record.distro)
      }
      removeWslHostEnvironment(this.deps.userDataPath(), environmentId)
      this.visible.delete(environmentId)
    } finally {
      // Why: a failed removal (e.g. EBUSY on Windows) must leave the host usable and removable.
      this.removing.delete(environmentId)
    }
    this.statuses.delete(environmentId)
    this.notifyStatusesChanged()
    await this.deps.removed(environmentId)
    return serverStop
  }

  /**
   * Turning the experiment off ends every connection and liveness watch and releases the
   * holders, so distros idle-stop; turning it on resumes only hosts open work needs.
   */
  async enabledChanged(enabled: boolean): Promise<void> {
    const connector = this.connector
    if (!connector) {
      return
    }
    if (enabled) {
      this.setVisibleWork([...this.visible], new Set())
      return
    }
    this.disableGeneration += 1
    for (const record of this.records()) {
      await connector.disconnect(record.distro)
      await connector.releaseHolder(record.distro)
      this.setStatus(record, { state: 'closed' })
    }
  }

  /** The user asked for this host: may boot its distro. `force` takes a deferred update now. */
  async connect(environmentId: string, options: { force?: boolean } = {}): Promise<void> {
    const record = this.recordForEnvironment(environmentId)
    if (!record) {
      throw new Error('This server is not a WSL host.')
    }
    const refusal = wslHostRunRefusal(this.deps)
    if (refusal || this.removing.has(environmentId)) {
      throw new Error(refusal?.message ?? WSL_HOST_REMOVING_MESSAGE)
    }
    await this.wsl.connect(record.distro, options)
  }

  /**
   * Before a call to a WSL host: a live connection serves it; otherwise connect only for open
   * work, and say why not instead of letting the call fail as an unreachable network server.
   */
  async ensureForRuntimeCall(environmentId: string): Promise<void> {
    const record = this.recordForEnvironment(environmentId)
    const connector = this.connector
    if (!record || !connector || (await connector.isReachable(record.distro, environmentId))) {
      return
    }
    const refusal = wslHostRunRefusal(this.deps)
    if (refusal || this.removing.has(environmentId)) {
      throw new Error(refusal?.message ?? WSL_HOST_REMOVING_MESSAGE)
    }
    if (!this.visible.has(environmentId)) {
      throw new Error(wslHostNotConnectedMessage(record.distro))
    }
    await connector.connect(record.distro)
  }

  /** Whether anything may still be started for this distro (spawn guard). */
  isKnownDistro(distro: string): boolean {
    return this.adding.has(wslDistroHolderKey(distro)) || this.recordForDistro(distro) !== null
  }

  setVisibleWork(environmentIds: readonly string[], previous = this.visible): void {
    this.visible = new Set(environmentIds.filter((id) => !this.removing.has(id)))
    if (!this.connector || !this.canRun()) {
      return
    }
    for (const environmentId of this.visible) {
      const record = !previous.has(environmentId) && this.recordForEnvironment(environmentId)
      if (record) {
        this.ensureForRuntimeCall(environmentId).catch((error: unknown) => {
          console.warn(`[wsl-hosts] Could not connect to ${record.distro}:`, error)
        })
      }
    }
  }

  hasUserVisibleWork(distro: string): boolean {
    const record = this.recordForDistro(distro)
    // Why the gate: liveness relaunches only for visible work, and none may run while off.
    const id = record?.environmentId
    return id ? this.canRun() && this.visible.has(id) && !this.removing.has(id) : false
  }

  /** Startup: keep the holders a previous run left, without booting anything. */
  async start(): Promise<void> {
    if (!this.connector || !this.canRun() || this.records().length === 0) {
      return
    }
    await this.connector.adoptHolders()
  }

  /** What the UI shows before offering any WSL host action. */
  hasServerFiles(): boolean {
    return this.deps.hasServerFiles()
  }

  private canRun(): boolean {
    return wslHostRunRefusal(this.deps) === null
  }

  async dispose(): Promise<void> {
    await this.connector?.dispose()
  }

  private setStatus(
    record: WslHostDeploymentRecord,
    status: WslOrcadConnectionStatus,
    connection: WslOrcadConnection | null = null
  ): void {
    const next = toWslHostStatus(record, status, connection)
    this.statuses.set(record.environmentId, next)
    this.deps.publish(next)
    this.notifyStatusesChanged()
  }

  private records(): WslHostDeploymentRecord[] {
    try {
      return readWslHostDeployments(this.deps.userDataPath()).deployments
    } catch (error) {
      console.warn('[wsl-hosts] Could not read WSL host records:', error)
      return []
    }
  }

  private recordForDistro(distro: string): WslHostDeploymentRecord | null {
    return this.records().find((record) => sameWslDistro(record.distro, distro)) ?? null
  }

  /** The registered WSL host behind an environment; null for any other environment. */
  recordForEnvironment(environmentId: string): WslHostDeploymentRecord | null {
    return this.records().find((record) => record.environmentId === environmentId) ?? null
  }
}
