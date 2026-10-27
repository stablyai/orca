/**
 * C7/E9: persist WSL hosts and connect them. A stopped distro boots only for an explicit
 * Add/Connect, or when the user switches to one of its workspaces. After a confirmed stop the host is
 * parked: polls and visible work keep it down until the user acts or the distro runs again.
 */
import { focusReachability } from './wsl-host-focus-reachability'
import { rethrowRetryable, settlingConnectFailure } from './wsl-host-connect-failure'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type {
  WslHostAddResult,
  WslHostConnectIntent,
  WslHostDistro,
  WslHostServerStop,
  WslHostStatus
} from '../../shared/wsl-host-types'
import type { WslHostConnector, WslHostServiceDependencies } from './wsl-host-connector-contract'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import {
  persistWslHostConnection,
  readWslHostRecordsQuietly,
  toWslHostStatus
} from './wsl-host-connection-record'
import {
  sameWslDistro,
  wslHostNotConnectedMessage,
  wslHostStoppedMessage,
  WSL_HOST_REMOVING_MESSAGE,
  wslHostRunRefusal
} from './wsl-host-add-admission'
import type { WslOrcadConnection } from './wsl-orcad-connection'
import { registerWslHost } from './wsl-host-registration'
import { WslHostStatusBoard } from './wsl-host-status-board'
import { withWslHostIds } from './wsl-host-records'
import { wslHolderKeepPolicy } from './wsl-orphan-holder-release'
import {
  admitConnectToPendingHost,
  readdPendingWslHost,
  removeWslHostServer
} from './wsl-host-removal'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'
import {
  forgetWslHostToWake,
  forgetWslHostsToWake,
  rememberWslHostsToWake
} from './wsl-host-early-wake'

export type {
  WslHostConnector,
  WslHostReachability,
  WslHostServiceDependencies
} from './wsl-host-connector-contract'

export class WslHostService {
  private connector: WslHostConnector | null = null
  private readonly board = new WslHostStatusBoard((status) => this.deps.publish(status))
  private readonly adding = new Map<string, Promise<WslHostAddResult>>()
  private visible = new Set<string>()
  private readonly parked = new Set<string>()
  private readonly removing = new Set<string>()
  // Invalidate in-flight Adds when disabled so they cannot later publish ready hosts.
  private disableGeneration = 0

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
    return this.board.list()
  }

  /** Hears every change to what `getStatuses` returns. */
  onStatusesChanged(listener: () => void): () => void {
    return this.board.onChanged(listener)
  }

  async listDistros(): Promise<WslHostDistro[]> {
    return withWslHostIds(await this.wsl.listDistros(), this.records())
  }

  add(args: { distro: string; startIfStopped?: boolean }): Promise<WslHostAddResult> {
    const key = wslDistroHolderKey(args.distro)
    const pending = this.adding.get(key)
    if (pending) {
      return pending
    }
    const unfinishedRemoval = this.recordForDistro(args.distro)
    if (unfinishedRemoval?.pendingStop) {
      const { environmentId } = unfinishedRemoval
      return readdPendingWslHost(args, {
        listDistros: () => this.wsl.listDistros(),
        keep: () => this.connect(environmentId, { withdrawPendingRemoval: true }),
        environmentId
      })
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
    // Block reconnect from visible work, liveness and calls before stopping; a failed removal
    // must leave the host usable and allow another attempt.
    this.removing.add(environmentId)
    const removal = await removeWslHostServer(
      this.deps.userDataPath(),
      this.connector,
      record
    ).finally(() => this.removing.delete(environmentId))
    // Removed or pending, nothing may boot it early at the next launch.
    forgetWslHostToWake(this.deps.userDataPath(), record.distro)
    if (!removal.removed) {
      this.setStatus(this.recordForEnvironment(environmentId) ?? record, { state: 'closed' })
      return removal.serverStop
    }
    this.visible.delete(environmentId)
    this.parked.delete(environmentId)
    this.board.delete(environmentId)
    await this.deps.removed(environmentId)
    return removal.serverStop
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

  /**
   * The user asked for this host: may boot its distro. An intent retries or forces an update.
   * Only the user's own Connect or Add withdraws an unfinished Remove; any other caller is refused.
   */
  async connect(
    environmentId: string,
    {
      withdrawPendingRemoval = false,
      ...options
    }: { intent?: WslHostConnectIntent; withdrawPendingRemoval?: boolean } = {}
  ): Promise<void> {
    const record = this.recordForEnvironment(environmentId)
    if (!record) {
      throw new Error('This server is not a WSL host.')
    }
    const refusal = wslHostRunRefusal(this.deps)
    if (refusal || this.removing.has(environmentId)) {
      throw new Error(refusal?.message ?? WSL_HOST_REMOVING_MESSAGE)
    }
    admitConnectToPendingHost(this.deps.userDataPath(), record, withdrawPendingRemoval)
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
    // A pending host never reconnects for a runtime call.
    admitConnectToPendingHost(this.deps.userDataPath(), record, false)
    if (reachability === 'stopped') {
      this.parked.add(environmentId)
    }
    if (this.parked.has(environmentId)) {
      throw new Error(wslHostStoppedMessage(record.distro))
    }
    // Unconfirmed (running list unreadable, or possibly stale right after an exit) or not
    // visible: refuse rather than risk a boot; liveness publishes the verdict.
    if (reachability !== 'unreachable' || !this.visible.has(environmentId)) {
      throw new Error(wslHostNotConnectedMessage(record.distro))
    }
    if (connector.isSettling(record.distro)) {
      throw settlingConnectFailure(record.distro)
    }
    await connector.connect(record.distro, { noBoot: true }).catch(rethrowRetryable(record.distro))
  }

  /**
   * The user switched to a workspace on this host (or launch restored it focused): the one
   * non-explicit act that may boot its distro, and it lifts a park.
   */
  focusHost(environmentId: string | null): void {
    const record = environmentId ? this.recordForEnvironment(environmentId) : null
    const runnable = record !== null && this.mayWake(record)
    // The next launch starts booting only this distro, early (none when off WSL or not runnable).
    rememberWslHostsToWake(this.deps.userDataPath(), record && runnable ? [record.distro] : [])
    if (record && runnable) {
      this.wake(record).catch((error: unknown) => {
        console.warn(`[wsl-hosts] Could not connect to ${record.distro}:`, error)
      })
    }
  }

  /** E9: an enabled automation came due with the host off; boots the distro once, lifting a park. */
  async wakeForAutomation(environmentId: string): Promise<void> {
    const record = this.recordForEnvironment(environmentId)
    if (record && this.mayWake(record)) {
      await this.wake(record)
    }
  }

  /** A host whose Remove is pending is never woken, by focus or by a due automation. */
  private mayWake(record: WslHostDeploymentRecord): boolean {
    return (
      !record.pendingStop &&
      Boolean(this.connector) &&
      this.canRun() &&
      !this.removing.has(record.environmentId)
    )
  }

  /** A focus entry or a due automation: lifts a park and may boot the distro. */
  private async wake(record: WslHostDeploymentRecord): Promise<void> {
    this.parked.delete(record.environmentId)
    // No bridge in this process yet means nothing answers; skip the WSL round trip (#33110).
    if (this.connector && (await focusReachability(this.connector, record)) !== 'available') {
      await this.connector.connect(record.distro)
    }
  }

  /** Whether the host's server answers through this process now; never starts a stopped distro. */
  async isConnected(environmentId: string): Promise<boolean> {
    const record = this.recordForEnvironment(environmentId)
    return record && this.connector
      ? (await this.connector.reachability(record.distro, environmentId)) === 'available'
      : false
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
    return id && !record.pendingStop
      ? this.canRun() && this.visible.has(id) && !this.removing.has(id)
      : false
  }

  /**
   * Startup: keep the holders a previous run left for its hosts, without booting anything. A
   * holder for a distro that is no longer a host (a failed add or remove), or any holder while
   * hosts are off, would keep its distro running forever, so it is released.
   */
  async start(): Promise<void> {
    if (!this.connector) {
      return
    }
    // An unfinished Remove shows as such from launch; nothing reconnects it.
    const pending = this.records().filter((record) => record.pendingStop)
    pending.forEach((record) => this.setStatus(record, { state: 'closed' }))
    await this.connector.adoptHolders(
      wslHolderKeepPolicy({
        userDataPath: this.deps.userDataPath(),
        keepHostHolders: this.canRun(),
        isAdding: (distro) => this.adding.has(wslDistroHolderKey(distro))
      })
    )
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
    this.board.set(toWslHostStatus(record, status, connection))
  }

  private records(): WslHostDeploymentRecord[] {
    return readWslHostRecordsQuietly(this.deps.userDataPath())
  }

  private recordForDistro(distro: string): WslHostDeploymentRecord | null {
    return this.records().find((record) => sameWslDistro(record.distro, distro)) ?? null
  }

  /** The registered WSL host behind an environment; null for any other environment. */
  recordForEnvironment(environmentId: string): WslHostDeploymentRecord | null {
    return this.records().find((record) => record.environmentId === environmentId) ?? null
  }
}
