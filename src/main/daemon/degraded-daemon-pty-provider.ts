import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { combineUnsubscribes } from './combine-unsubscribes'
import { shutdownDegradedFallbackSessions } from './degraded-daemon-fallback-shutdown'
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
import {
  adoptOwningProvider,
  attachDaemonOwnedSession,
  findDaemonAdapter,
  listProviderSessionIds
} from './degraded-daemon-session-routing'
import { DegradedDaemonFreshSpawnRouter } from './degraded-daemon-fresh-spawn-routing'
import { DegradedDaemonOwnerRecovery } from './degraded-daemon-owner-recovery'

export class DegradedDaemonPtyProvider implements IPtyProvider {
  readonly isDegraded = true

  private current: DaemonPtyAdapter
  private legacy: DaemonPtyAdapter[]
  private fallback: IPtyProvider
  private sessionProviders = new Map<string, IPtyProvider>()
  private freshSpawns: DegradedDaemonFreshSpawnRouter
  private ownerRecovery: DegradedDaemonOwnerRecovery
  private unsubscribers: (() => void)[] = []
  private dataListeners: ((payload: PtyDataEvent) => void)[] = []
  private exitListeners: ((payload: { id: string; code: number }) => void)[] = []

  constructor(opts: {
    current: DaemonPtyAdapter
    legacy: DaemonPtyAdapter[]
    fallback: IPtyProvider
    probeCurrentDaemonSpawn?: () => Promise<boolean>
  }) {
    this.current = opts.current
    this.legacy = opts.legacy
    this.fallback = opts.fallback
    this.freshSpawns = new DegradedDaemonFreshSpawnRouter(
      opts.current,
      opts.fallback,
      this.sessionProviders,
      opts.probeCurrentDaemonSpawn ?? null
    )
    this.ownerRecovery = new DegradedDaemonOwnerRecovery(
      this.allProviders(),
      this.allDaemonAdapters(),
      this.sessionProviders,
      (spawnOpts) => this.freshSpawns.spawn(spawnOpts)
    )

    for (const provider of this.allProviders()) {
      this.unsubscribers.push(
        provider.onData((payload) => this.dataListeners.forEach((listener) => listener(payload))),
        provider.onExit((payload) => {
          this.ownerRecovery.forgetRoute(payload.id)
          this.exitListeners.forEach((listener) => listener(payload))
        })
      )
    }
    this.unsubscribers.push(...this.ownerRecovery.subscribeIdentityChanges())
  }

  async discoverDaemonSessions(): Promise<void> {
    await this.ownerRecovery.discoverRoutes()
  }

  get routesFreshSpawnsToLocalProvider(): true | undefined {
    return this.freshSpawns.routesToFallback
  }

  recoverFreshSpawnRouting = (): Promise<boolean> => this.freshSpawns.recover()

  supportsGitCredentialGuardHost = (id?: string): boolean =>
    this.freshSpawns.supportsGitGuardHost(id)

  canProvideAuthoritativeBufferSnapshot = (id: string): boolean =>
    this.freshSpawns.canProvideSnapshot(id)

  spawn = (opts: PtySpawnOptions): Promise<PtySpawnResult> => this.ownerRecovery.spawn(opts)

  // Why refuse the fallback route (unknown ids resolve to it): see attachDaemonOwnedSession.
  attach = (id: string): ReturnType<IPtyProvider['attach']> =>
    attachDaemonOwnedSession(this.providerFor(id), this.fallback, id)

  hasPty(id: string): boolean {
    const mapped = this.sessionProviders.get(id)
    return mapped ? (mapped.hasPty?.(id) ?? true) : this.findProviderForExistingSession(id) !== null
  }

  async probePtyLiveness(id: string): Promise<boolean | null> {
    const mapped = this.sessionProviders.get(id)
    if (mapped && (mapped.hasPty?.(id) ?? true)) {
      return true
    }
    return await this.ownerRecovery.probe(id)
  }

  // Why: an unknown id cannot borrow listing authority from the fresh-spawn provider.
  providesAgentSessionOwnerListings = (ptyId: string): boolean =>
    (
      this.sessionProviders.get(ptyId) ?? this.findProviderForExistingSession(ptyId)
    )?.providesAgentSessionOwnerListings?.(ptyId) === true

  write(id: string, data: string): boolean | void {
    return this.providerFor(id).write(id, data)
  }

  async writeWithSettlement(id: string, data: string): Promise<boolean> {
    const provider = this.providerFor(id)
    return provider.writeWithSettlement
      ? await provider.writeWithSettlement(id, data)
      : provider.write(id, data) !== false
  }

  resize(id: string, cols: number, rows: number): void {
    this.providerFor(id).resize(id, cols, rows)
  }

  pauseProducer(id: string): void {
    this.providerFor(id).pauseProducer?.(id)
  }

  resumeProducer(id: string): void {
    this.providerFor(id).resumeProducer?.(id)
  }

  setPtyBackgrounded(id: string, background: boolean): void {
    this.providerFor(id).setPtyBackgrounded?.(id, background)
  }

  async shutdown(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<void> {
    await this.providerFor(id).shutdown(id, opts)
    if (!opts.keepHistory) {
      this.sessionProviders.delete(id)
    }
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    await this.providerFor(id).sendSignal(id, signal)
  }

  async getCwd(id: string): Promise<string> {
    return this.providerFor(id).getCwd(id)
  }

  async getInitialCwd(id: string): Promise<string> {
    return this.providerFor(id).getInitialCwd(id)
  }

  async getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    return (await this.providerFor(id).getAppliedSize?.(id)) ?? null
  }

  async getBufferSnapshot(
    id: string,
    opts?: { scrollbackRows?: number }
  ): Promise<PtyProviderBufferSnapshot | null> {
    // Why: recovery must reach the legacy adapter that owns the thinned session model.
    return (await this.providerFor(id).getBufferSnapshot?.(id, opts)) ?? null
  }

  clearBuffer = (id: string): Promise<void> => this.providerFor(id).clearBuffer(id)

  async closeStartupQueryAuthority(id: string): Promise<number> {
    return (await this.providerFor(id).closeStartupQueryAuthority?.(id)) ?? 0
  }

  acknowledgeDataEvent(id: string, charCount: number): void {
    this.providerFor(id).acknowledgeDataEvent(id, charCount)
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    return this.providerFor(id).hasChildProcesses(id)
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    return this.providerFor(id).getForegroundProcess(id)
  }
  inspectProcess(id: string) {
    return this.hasPty(id)
      ? inspectPtyProviderProcess(this.providerFor(id), id)
      : Promise.reject(new Error('terminal_gone'))
  }
  async confirmForegroundProcess(id: string): Promise<string | null> {
    return this.providerFor(id).confirmForegroundProcess?.(id) ?? null
  }

  async serialize(ids: string[]): Promise<string> {
    return this.fallback.serialize(ids)
  }

  async revive(state: string): Promise<void> {
    await this.fallback.revive(state)
  }

  async listProcesses(opts?: { deadlineMs?: number }): Promise<PtyProcessInfo[]> {
    const results = await Promise.all(
      this.allProviders().map((provider) => provider.listProcesses(opts))
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
      this.allProviders().flatMap((provider) => provider.onBackgroundStreamEvent?.(callback) ?? [])
    )
  }

  // Why: main subscribes on the routed provider, so without this the dead-endpoint
  // fan-out reaches no listener and only the written pane recovers (STA-2373). Daemon
  // adapters only — the local fallback has no dead-socket problem.
  onWriteUnavailable(callback: (payload: { id: string }) => void): () => void {
    return combineUnsubscribes(
      this.allDaemonAdapters().map((adapter) => adapter.onWriteUnavailable(callback))
    )
  }

  onReplay(callback: (payload: { id: string; data: string }) => void): () => void {
    const unsubscribes = this.allProviders().map((provider) => provider.onReplay(callback))
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
    findDaemonAdapter(this.sessionProviders, this.allDaemonAdapters(), sessionId)?.ackColdRestore(
      sessionId
    )
  }

  clearTombstone(sessionId: string): void {
    findDaemonAdapter(this.sessionProviders, this.allDaemonAdapters(), sessionId)?.clearTombstone(
      sessionId
    )
  }

  async reconcileOnStartup(validWorktreeIds: Set<string>): Promise<{
    alive: string[]
    killed: string[]
  }> {
    return await this.ownerRecovery.reconcileOnStartup(validWorktreeIds)
  }

  dispose(): void {
    this.disposeProviderOnly()
    for (const adapter of this.allDaemonAdapters()) {
      adapter.dispose()
    }
  }

  disposeProviderOnly(): void {
    combineUnsubscribes(this.unsubscribers.splice(0))()
  }

  async shutdownFallbackSessions(): Promise<number> {
    return shutdownDegradedFallbackSessions(this.sessionProviders, this.fallback)
  }

  getCurrentDaemonSessionIds(): string[] {
    return listProviderSessionIds(this.sessionProviders, this.current)
  }

  fanoutCurrentDaemonSyntheticExits(code: number): void {
    for (const id of this.getCurrentDaemonSessionIds()) {
      this.sessionProviders.delete(id)
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

  private providerFor(sessionId: string): IPtyProvider {
    return (
      this.sessionProviders.get(sessionId) ??
      this.findProviderForExistingSession(sessionId) ??
      this.fallback
    )
  }

  private findProviderForExistingSession(sessionId: string): IPtyProvider | null {
    return adoptOwningProvider(this.sessionProviders, this.allProviders(), sessionId)
  }

  private allProviders(): IPtyProvider[] {
    return [this.fallback, ...this.allDaemonAdapters()]
  }

  private allDaemonAdapters(): DaemonPtyAdapter[] {
    return [this.current, ...this.legacy]
  }
}
