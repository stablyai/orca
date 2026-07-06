import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type {
  IPtyProvider,
  PtyProcessInfo,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/types'

type ManagedPtyProvider = IPtyProvider & {
  disconnectOnly?: () => Promise<void>
  dispose?: () => void
}

export class DegradedDaemonPtyProvider implements IPtyProvider {
  readonly routesFreshSpawnsToLocalProvider = true
  // Why: the preserved daemon answers protocol but cannot spawn fresh PTYs.
  // Surfaced (e.g. via pty:management:listSessions) so the UI can warn that
  // new terminals are running without daemon persistence until a restart.
  readonly isDegraded = true

  private current: DaemonPtyAdapter
  private legacy: DaemonPtyAdapter[]
  private fallback: ManagedPtyProvider
  private sessionProviders = new Map<string, ManagedPtyProvider>()
  private unsubscribers: (() => void)[] = []
  private dataListeners: ((payload: { id: string; data: string }) => void)[] = []
  private exitListeners: ((payload: { id: string; code: number }) => void)[] = []

  constructor(opts: {
    current: DaemonPtyAdapter
    legacy: DaemonPtyAdapter[]
    fallback: ManagedPtyProvider
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
    if (mapped) {
      return mapped.hasPty?.(id) ?? true
    }
    return this.findProviderForExistingSession(id) !== null
  }

  write(id: string, data: string): void {
    this.providerFor(id).write(id, data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.providerFor(id).resize(id, cols, rows)
  }

  async shutdown(id: string, opts: { immediate?: boolean; keepHistory?: boolean }): Promise<void> {
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

  async clearBuffer(id: string): Promise<void> {
    await this.providerFor(id).clearBuffer(id)
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

  async serialize(ids: string[]): Promise<string> {
    return this.fallback.serialize(ids)
  }

  async revive(state: string): Promise<void> {
    await this.fallback.revive(state)
  }

  async listProcesses(): Promise<PtyProcessInfo[]> {
    const results = await Promise.all(
      this.allProviders().map((provider) => provider.listProcesses())
    )
    return results.flat()
  }

  async getDefaultShell(): Promise<string> {
    return this.fallback.getDefaultShell()
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    return this.fallback.getProfiles()
  }

  onData(callback: (payload: { id: string; data: string }) => void): () => void {
    this.dataListeners.push(callback)
    return () => {
      const idx = this.dataListeners.indexOf(callback)
      if (idx !== -1) {
        this.dataListeners.splice(idx, 1)
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
    const ids = [...this.sessionProviders]
      .filter(([, provider]) => provider === this.fallback)
      .map(([id]) => id)
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        await this.fallback.shutdown(id, { immediate: true })
        this.sessionProviders.delete(id)
      })
    )
    // Why: this runs first in the daemon-restart sequence. A throw here would
    // abort the whole restart and leave "Restart daemon" — the user's recovery
    // path for a wedged terminal — unusable, recreating the original lockup. So
    // it is best-effort: log failures, keep restarting, and only count the
    // sessions that actually shut down.
    const failed = results.filter((result) => result.status === 'rejected')
    if (failed.length > 0) {
      console.warn(
        `[daemon] ${failed.length} local fallback PTY session(s) failed to shut down during daemon restart; continuing restart`,
        ...failed.map((result) => (result as PromiseRejectedResult).reason)
      )
    }
    return results.length - failed.length
  }

  getCurrentDaemonSessionIds(): string[] {
    return this.sessionIdsForProvider(this.current)
  }

  fanoutCurrentDaemonSyntheticExits(code: number): void {
    for (const id of this.getCurrentDaemonSessionIds()) {
      this.sessionProviders.delete(id)
      // Why: sessions discovered from listProcesses may not exist in the
      // adapter's active-session set, but restart still kills that daemon.
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

  private providerFor(sessionId: string): ManagedPtyProvider {
    return (
      this.sessionProviders.get(sessionId) ??
      this.findProviderForExistingSession(sessionId) ??
      this.fallback
    )
  }

  private findProviderForExistingSession(sessionId: string): ManagedPtyProvider | null {
    for (const provider of this.allProviders()) {
      if (provider.hasPty?.(sessionId) === true) {
        this.sessionProviders.set(sessionId, provider)
        return provider
      }
    }
    return null
  }

  private sessionIdsForProvider(provider: ManagedPtyProvider): string[] {
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

  private allProviders(): ManagedPtyProvider[] {
    return [this.fallback, ...this.allDaemonAdapters()]
  }

  private allDaemonAdapters(): DaemonPtyAdapter[] {
    return [this.current, ...this.legacy]
  }
}
