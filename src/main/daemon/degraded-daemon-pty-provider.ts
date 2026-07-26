import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { shutdownDegradedFallbackSessions } from './degraded-daemon-fallback-shutdown'
import { inspectPtyProviderProcess } from '../providers/pty-process-inspection'
import type { IPtyProvider, PtyBackgroundStreamEvent } from '../providers/types'
import type { PtyDataEvent, PtyProviderBufferSnapshot } from '../providers/types'
import type { PtyProcessInfo, PtySpawnOptions, PtySpawnResult } from '../providers/types'

export class DegradedDaemonPtyProvider implements IPtyProvider {
  readonly routesFreshSpawnsToLocalProvider = true
  // Why: surface that fresh PTYs lack daemon persistence until restart.
  readonly isDegraded = true

  private current: DaemonPtyAdapter
  private legacy: DaemonPtyAdapter[]
  private fallback: IPtyProvider
  private sessionProviders = new Map<string, IPtyProvider>()
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

    for (const provider of this.allProviders()) {
      this.unsubscribers.push(
        provider.onData((payload) => {
          for (const listener of this.dataListeners) {
            listener(payload)
          }
        }),
        provider.onExit((payload) => {
          this.sessionProviders.delete(payload.id)
          for (const listener of this.exitListeners) {
            listener(payload)
          }
        })
      )
    }
  }

  async discoverDaemonSessions(): Promise<void> {
    for (const adapter of this.allDaemonAdapters()) {
      try {
        const sessions = await adapter.listProcesses()
        for (const session of sessions) {
          this.sessionProviders.set(session.id, adapter)
        }
      } catch (error) {
        console.warn('[daemon] Failed to discover degraded daemon sessions', error)
      }
    }
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const mapped = opts.sessionId ? this.sessionProviders.get(opts.sessionId) : undefined
    const target = mapped ?? this.fallback
    const result = await target.spawn(opts)
    this.sessionProviders.set(result.id, target)
    return result
  }

  async attach(id: string): Promise<void> {
    await this.providerFor(id).attach(id)
  }

  hasPty(id: string): boolean {
    const mapped = this.sessionProviders.get(id)
    return mapped ? (mapped.hasPty?.(id) ?? true) : this.findProviderForExistingSession(id) !== null
  }

  // Why: an unknown id cannot borrow listing authority from the fresh-spawn provider.
  providesAgentSessionOwnerListings = (ptyId: string): boolean =>
    (
      this.sessionProviders.get(ptyId) ?? this.findProviderForExistingSession(ptyId)
    )?.providesAgentSessionOwnerListings?.(ptyId) === true

  write(id: string, data: string): void {
    this.providerFor(id).write(id, data)
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

  async clearBuffer(id: string): Promise<void> {
    await this.providerFor(id).clearBuffer(id)
  }

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
    const unsubscribes = this.allProviders().flatMap(
      (provider) => provider.onBackgroundStreamEvent?.(callback) ?? []
    )
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
    }
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
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
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
    this.daemonAdapterFor(sessionId)?.ackColdRestore(sessionId)
  }

  clearTombstone(sessionId: string): void {
    this.daemonAdapterFor(sessionId)?.clearTombstone(sessionId)
  }

  async reconcileOnStartup(validWorktreeIds: Set<string>): Promise<{
    alive: string[]
    killed: string[]
  }> {
    const alive: string[] = []
    const killed: string[] = []
    for (const adapter of this.allDaemonAdapters()) {
      const result = await adapter.reconcileOnStartup(validWorktreeIds)
      for (const id of result.alive) {
        alive.push(id)
        this.sessionProviders.set(id, adapter)
      }
      for (const id of result.killed) {
        killed.push(id)
        this.sessionProviders.delete(id)
      }
    }
    return { alive, killed }
  }

  dispose(): void {
    this.disposeProviderOnly()
    for (const adapter of this.allDaemonAdapters()) {
      adapter.dispose()
    }
  }

  disposeProviderOnly(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe()
    }
  }

  async shutdownFallbackSessions(): Promise<number> {
    return shutdownDegradedFallbackSessions(this.sessionProviders, this.fallback)
  }

  getCurrentDaemonSessionIds(): string[] {
    return this.sessionIdsForProvider(this.current)
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
    for (const provider of this.allProviders()) {
      if (provider.hasPty?.(sessionId) === true) {
        this.sessionProviders.set(sessionId, provider)
        return provider
      }
    }
    return null
  }

  private sessionIdsForProvider(provider: IPtyProvider): string[] {
    return [...this.sessionProviders]
      .filter(([, mappedProvider]) => mappedProvider === provider)
      .map(([id]) => id)
  }

  private daemonAdapterFor(sessionId: string): DaemonPtyAdapter | null {
    const provider = this.sessionProviders.get(sessionId)
    return provider && this.allDaemonAdapters().includes(provider as DaemonPtyAdapter)
      ? (provider as DaemonPtyAdapter)
      : null
  }

  private allProviders(): IPtyProvider[] {
    return [this.fallback, ...this.allDaemonAdapters()]
  }

  private allDaemonAdapters(): DaemonPtyAdapter[] {
    return [this.current, ...this.legacy]
  }
}
