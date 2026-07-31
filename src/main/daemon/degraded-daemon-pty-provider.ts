import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { combineUnsubscribes } from './combine-unsubscribes'
import { inspectPtyProviderProcess } from '../providers/pty-process-inspection'
import type {
  IPtyProvider,
  PtyBackgroundStreamEvent,
  PtyDataEvent,
  PtyProviderBufferSnapshot,
  PtyProcessInfo,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/types'
import { DaemonSnapshotAcknowledgementRoutes } from './daemon-snapshot-acknowledgement-routes'
import { DegradedDaemonSessionRouting } from './degraded-daemon-session-routing'

export class DegradedDaemonPtyProvider implements IPtyProvider {
  readonly routesFreshSpawnsToLocalProvider = true
  // Why: surface that fresh PTYs lack daemon persistence until restart.
  readonly isDegraded = true

  private current: DaemonPtyAdapter
  private legacy: DaemonPtyAdapter[]
  private fallback: IPtyProvider
  private readonly routing: DegradedDaemonSessionRouting
  private readonly snapshotAcks = new DaemonSnapshotAcknowledgementRoutes()
  private unsubscribers: (() => void)[] = []
  private dataListeners: ((payload: PtyDataEvent) => void)[] = []
  private exitListeners: ((payload: { id: string; code: number }) => void)[] = []

  constructor(opts: {
    current: DaemonPtyAdapter
    legacy: DaemonPtyAdapter[]
    fallback: IPtyProvider
  }) {
    this.current = opts.current
    this.legacy = opts.legacy
    this.fallback = opts.fallback
    this.routing = new DegradedDaemonSessionRouting(
      this.current,
      this.legacy,
      this.fallback,
      this.snapshotAcks
    )

    for (const provider of this.allProviders()) {
      this.unsubscribers.push(
        provider.onData((payload) => {
          if (!this.routing.shouldForwardStreamEvent(provider, payload.id)) {
            return
          }
          for (const listener of this.dataListeners) {
            listener(payload)
          }
        }),
        provider.onExit((payload) => {
          if (!this.routing.recordExit(provider, payload.id)) {
            return
          }
          for (const listener of this.exitListeners) {
            listener(payload)
          }
        })
      )
    }
  }

  async discoverDaemonSessions(): Promise<void> {
    await this.routing.discover()
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    return await this.routing.spawn(opts)
  }

  async attach(id: string): Promise<void> {
    await this.routing.providerFor(id).attach(id)
  }

  hasPty(id: string): boolean {
    return this.routing.hasPty(id)
  }

  async probePtyLiveness(id: string): Promise<boolean | null> {
    return await this.routing.probePtyLiveness(id)
  }

  // Why: an unknown id cannot borrow listing authority from the fresh-spawn provider.
  providesAgentSessionOwnerListings = (ptyId: string): boolean =>
    this.routing.ownerForHint(ptyId)?.providesAgentSessionOwnerListings?.(ptyId) === true

  write(id: string, data: string): void {
    this.routing.providerFor(id).write(id, data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.routing.providerFor(id).resize(id, cols, rows)
  }

  pauseProducer(id: string): void {
    this.routing.ownerForHint(id)?.pauseProducer?.(id)
  }

  resumeProducer(id: string): void {
    this.routing.ownerForHint(id)?.resumeProducer?.(id)
  }

  setPtyBackgrounded(id: string, background: boolean): void {
    this.routing.ownerForHint(id)?.setPtyBackgrounded?.(id, background)
  }

  async shutdown(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<void> {
    const provider = this.routing.providerFor(id)
    await provider.shutdown(id, opts)
    if (!opts.keepHistory) {
      this.routing.recordShutdown(id, provider)
    }
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    await this.routing.providerFor(id).sendSignal(id, signal)
  }

  async getCwd(id: string): Promise<string> {
    return this.routing.providerFor(id).getCwd(id)
  }

  async getInitialCwd(id: string): Promise<string> {
    return this.routing.providerFor(id).getInitialCwd(id)
  }

  async getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    return (await this.routing.providerFor(id).getAppliedSize?.(id)) ?? null
  }

  async getBufferSnapshot(
    id: string,
    opts?: { scrollbackRows?: number }
  ): Promise<PtyProviderBufferSnapshot | null> {
    return await this.snapshotAcks.capture(
      id,
      opts,
      this.routing.providerFor(id),
      this.allDaemonAdapters()
    )
  }

  async clearBuffer(id: string): Promise<void> {
    await this.routing.providerFor(id).clearBuffer(id)
  }

  async closeStartupQueryAuthority(id: string): Promise<number> {
    return (await this.routing.providerFor(id).closeStartupQueryAuthority?.(id)) ?? 0
  }

  acknowledgeDataEvent(id: string, charCount: number): void {
    this.routing.providerFor(id).acknowledgeDataEvent(id, charCount)
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    return this.routing.providerFor(id).hasChildProcesses(id)
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    return this.routing.providerFor(id).getForegroundProcess(id)
  }
  inspectProcess(id: string) {
    return this.hasPty(id)
      ? inspectPtyProviderProcess(this.routing.providerFor(id), id)
      : Promise.reject(new Error('terminal_gone'))
  }
  async confirmForegroundProcess(id: string): Promise<string | null> {
    return this.routing.providerFor(id).confirmForegroundProcess?.(id) ?? null
  }

  async serialize(ids: string[]): Promise<string> {
    return this.fallback.serialize(ids)
  }

  async revive(state: string): Promise<void> {
    await this.fallback.revive(state)
  }

  async listProcesses(opts?: { deadlineMs?: number }): Promise<PtyProcessInfo[]> {
    const results = await Promise.all(
      this.routing.allProviders().map((provider) => provider.listProcesses(opts))
    )
    return results.flat()
  }

  async getDefaultShell(): Promise<string> {
    return this.fallback.getDefaultShell()
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    return this.fallback.getProfiles()
  }

  onData(callback: (payload: PtyDataEvent) => void): () => void {
    this.dataListeners.push(callback)
    return () => {
      const idx = this.dataListeners.indexOf(callback)
      if (idx !== -1) {
        this.dataListeners.splice(idx, 1)
      }
    }
  }

  onBackgroundStreamEvent(callback: (payload: PtyBackgroundStreamEvent) => void): () => void {
    return combineUnsubscribes(
      this.allProviders().flatMap((provider) => {
        return (
          provider.onBackgroundStreamEvent?.((payload) => {
            if (this.routing.shouldForwardStreamEvent(provider, payload.id)) {
              callback(payload)
            }
          }) ?? []
        )
      })
    )
  }

  // Why: main subscribes on the routed provider, so without this the dead-endpoint
  // fan-out reaches no listener and only the written pane recovers (STA-2373). Daemon
  // adapters only — the local fallback has no dead-socket problem.
  onWriteUnavailable(callback: (payload: { id: string }) => void): () => void {
    return combineUnsubscribes(
      this.allDaemonAdapters().map((adapter) =>
        adapter.onWriteUnavailable((payload) => {
          if (this.routing.shouldForwardWriteUnavailable(adapter, payload.id)) {
            callback(payload)
          }
        })
      )
    )
  }

  onReplay(callback: (payload: { id: string; data: string }) => void): () => void {
    const unsubscribes = this.allProviders().map((provider) =>
      provider.onReplay((payload) => {
        if (this.routing.shouldForwardStreamEvent(provider, payload.id)) {
          callback(payload)
        }
      })
    )
    let active = true
    const trackedUnsubscribe = (): void => {
      if (!active) {
        return
      }
      active = false
      const idx = this.unsubscribers.indexOf(trackedUnsubscribe)
      if (idx !== -1) {
        this.unsubscribers.splice(idx, 1)
      }
      combineUnsubscribes(unsubscribes)()
    }
    this.unsubscribers.push(trackedUnsubscribe)
    return trackedUnsubscribe
  }

  onExit(callback: (payload: { id: string; code: number }) => void): () => void {
    this.exitListeners.push(callback)
    return () => {
      const idx = this.exitListeners.indexOf(callback)
      if (idx !== -1) {
        this.exitListeners.splice(idx, 1)
      }
    }
  }

  ackColdRestore(sessionId: string): void {
    this.snapshotAcks.acknowledge(sessionId)
  }

  clearTombstone(sessionId: string): void {
    this.routing.clearTombstone(sessionId)
  }

  async reconcileOnStartup(validWorktreeIds: Set<string>): Promise<{
    alive: string[]
    killed: string[]
  }> {
    const result = await this.routing.reconcile(validWorktreeIds)
    return result
  }

  dispose(): void {
    this.disposeProviderOnly()
    for (const adapter of this.allDaemonAdapters()) {
      adapter.dispose()
    }
  }

  disposeProviderOnly(): void {
    combineUnsubscribes(this.unsubscribers.splice(0))()
    this.routing.dispose()
  }

  async shutdownFallbackSessions(): Promise<number> {
    return await this.routing.shutdownFallbackSessions()
  }

  getCurrentDaemonSessionIds(): string[] {
    return this.routing.currentSessionIds()
  }

  fanoutCurrentDaemonSyntheticExits(code: number): void {
    for (const id of this.routing.recordCurrentSyntheticExits()) {
      // Why: restart kills listed sessions even when the adapter did not track them active.
      // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
      for (const listener of [...this.exitListeners]) {
        listener({ id, code })
      }
    }
  }

  async disconnectOnly(): Promise<void> {
    this.disposeProviderOnly()
    await Promise.all(this.allDaemonAdapters().map((adapter) => adapter.disconnectOnly()))
  }

  getCurrentAdapter(): DaemonPtyAdapter {
    return this.current
  }

  getLegacyAdapters(): readonly DaemonPtyAdapter[] {
    return this.legacy
  }

  getAllAdapters(): readonly DaemonPtyAdapter[] {
    return this.allDaemonAdapters()
  }

  private allProviders(): IPtyProvider[] {
    return this.routing.allProviders()
  }

  private allDaemonAdapters(): DaemonPtyAdapter[] {
    return [...this.routing.allAdapters()]
  }
}
