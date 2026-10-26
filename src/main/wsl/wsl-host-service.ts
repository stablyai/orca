/**
 * C7/E9: persist WSL hosts and connect them. A stopped distro boots only for an explicit
 * Add/Connect, or when the user switches to one of its workspaces. After a confirmed stop the host is
 * parked: polls and visible work keep it down until the user acts or the distro runs again.
 */
import { errorMessage } from '../../shared/error-message'
import { focusReachability } from './wsl-host-focus-reachability'
import { removeWslHostEnvironment } from '../../shared/runtime-environment-wsl-host-store'
import {
  readWslHostDeployments,
  type WslHostDeploymentRecord
} from '../../shared/wsl-host-deployment-store'
import type {
  WslHostAddResult,
  WslHostConnectIntent,
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
  wslHostStoppedMessage,
  WSL_HOST_REMOVING_MESSAGE,
  wslHostRunRefusal
} from './wsl-host-add-admission'
import type { WslOrcadConnection } from './wsl-orcad-connection'
import { registerWslHost } from './wsl-host-registration'
import type { WslOrcadConnectIntent, WslOrcadConnectionStatus } from './wsl-orcad-connection-status'
import {
  forgetWslHostToWake,
  forgetWslHostsToWake,
  rememberWslHostsToWake
} from './wsl-host-early-wake'

/** `stopped` and `unreachable` rest on a confirmed running list; `unavailable` could not read it. */
export type WslHostReachability = 'available' | 'unreachable' | 'stopped' | 'unavailable'

/** The WSL side the service drives: C3 holder, C5 connections, C6 liveness (or an e2e fake). */
export type WslHostConnector = {
  listDistros(): Promise<WslHostDistroCandidate[]>
  /** Runs in the distro, so it boots a stopped one: only after the user chose to. */
  readOrcadPublicKey(distro: string): Promise<string | null>
  /** User-initiated; may boot the distro. An intent retries or forces a skipped update. */
  connect(distro: string, options?: WslOrcadConnectIntent): Promise<WslOrcadConnection>
  /** Explicit retry must clear pairing-repair failures and spent caps. */
  forgetPairingFailures?(environmentId: string): void
  get(distro: string): WslOrcadConnection | null
  /** Checks the paired server without starting a stopped or unconfirmed distro. */
  isReachable(distro: string, environmentId: string): Promise<boolean>
  /** The same check, telling a confirmed-stopped distro from an unconfirmed one. */
  reachability(distro: string, environmentId: string): Promise<WslHostReachability>
  /** Liveness is deciding whether the distro stopped; its running list may be stale. */
  isSettling(distro: string): boolean
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
  private readonly parked = new Set<string>()
  private readonly removing = new Set<string>()
  // Invalidate in-flight Adds when disabled so they cannot later publish ready hosts.
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
    if (status.state === 'distro-stopped') {
      this.parked.add(record.environmentId)
    } else if (status.state === 'ready') {
      this.parked.delete(record.environmentId)
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
    // Block reconnect from visible work, liveness and calls before stopping.
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
      forgetWslHostToWake(this.deps.userDataPath(), record.distro)
      this.visible.delete(environmentId)
      this.parked.delete(environmentId)
    } finally {
      // Failed removal must leave the host usable and allow another removal attempt.
      this.removing.delete(environmentId)
    }
    this.statuses.delete(environmentId)
    this.notifyStatusesChanged()
    await this.deps.removed(environmentId)
    return serverStop
  }

  /** Disable closes connections/watches and releases holders; reenable resumes only hosts needed by visible work. */
  async enabledChanged(enabled: boolean): Promise<void> {
    const connector = this.connector
    if (!connector) {
      return
    }
    if (enabled) {
      // Nothing boots here: the window re-reports its focused host, the only one that may (E9).
      return
    }
    this.disableGeneration += 1
    forgetWslHostsToWake(this.deps.userDataPath())
    for (const record of this.records()) {
      await connector.disconnect(record.distro)
      await connector.releaseHolder(record.distro)
      this.setStatus(record, { state: 'closed' })
    }
  }

  /** The user asked for this host: may boot its distro. An intent retries or forces an update. */
  async connect(
    environmentId: string,
    options: { intent?: WslHostConnectIntent } = {}
  ): Promise<void> {
    const record = this.recordForEnvironment(environmentId)
    if (!record) {
      throw new Error('This server is not a WSL host.')
    }
    const refusal = wslHostRunRefusal(this.deps)
    if (refusal || this.removing.has(environmentId)) {
      throw new Error(refusal?.message ?? WSL_HOST_REMOVING_MESSAGE)
    }
    this.wsl.forgetPairingFailures?.(environmentId)
    this.parked.delete(environmentId)
    await this.wsl.connect(record.distro, options)
  }

  /**
   * A runtime call (a poll, a fetch) never boots a distro (E9). It reconnects only to a distro
   * confirmed running and only for visible work; a confirmed stop parks the host.
   */
  async ensureForRuntimeCall(environmentId: string): Promise<void> {
    const record = this.recordForEnvironment(environmentId)
    const connector = this.connector
    if (!record || !connector) {
      return
    }
    const reachability = await connector.reachability(record.distro, environmentId)
    if (reachability === 'available') {
      return
    }
    const refusal = wslHostRunRefusal(this.deps)
    if (refusal || this.removing.has(environmentId)) {
      throw new Error(refusal?.message ?? WSL_HOST_REMOVING_MESSAGE)
    }
    if (reachability === 'stopped') {
      this.parked.add(environmentId)
    }
    if (this.parked.has(environmentId)) {
      throw new Error(wslHostStoppedMessage(record.distro))
    }
    // Unconfirmed (running list unreadable, or possibly stale right after an exit) or not
    // visible: refuse rather than risk a boot; liveness publishes the verdict.
    if (
      reachability !== 'unreachable' ||
      !this.visible.has(environmentId) ||
      connector.isSettling(record.distro)
    ) {
      throw new Error(wslHostNotConnectedMessage(record.distro))
    }
    await connector.connect(record.distro, { noBoot: true })
  }

  /**
   * The user switched to a workspace on this host (or launch restored it focused): the one
   * non-explicit act that may boot its distro, and it lifts a park.
   */
  focusHost(environmentId: string | null): void {
    const record = environmentId ? this.recordForEnvironment(environmentId) : null
    const runnable =
      record && this.connector && this.canRun() && !this.removing.has(record.environmentId)
    // The next launch starts booting only this distro, early (none when off WSL or not runnable).
    rememberWslHostsToWake(this.deps.userDataPath(), runnable ? [record.distro] : [])
    if (!record || !runnable || !this.connector) {
      return
    }
    this.parked.delete(record.environmentId)
    void focusReachability(this.connector, record)
      .then((reachability) =>
        reachability === 'available' ? undefined : this.connector?.connect(record.distro)
      )
      .catch((error: unknown) => {
        console.warn(`[wsl-hosts] Could not connect to ${record.distro}:`, error)
      })
  }

  /** Whether anything may still be started for this distro (spawn guard). */
  isKnownDistro(distro: string): boolean {
    return this.adding.has(wslDistroHolderKey(distro)) || this.recordForDistro(distro) !== null
  }

  /** Hosts with open work across windows; this never connects anything by itself. */
  setVisibleWork(environmentIds: readonly string[]): void {
    this.visible = new Set(environmentIds.filter((id) => !this.removing.has(id)))
  }

  hasUserVisibleWork(distro: string): boolean {
    const record = this.recordForDistro(distro)
    // Liveness needs visible demand, an enabled gate and no removal in progress.
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
