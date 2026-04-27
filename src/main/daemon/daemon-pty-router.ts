import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../providers/types'

export class DaemonPtyRouter implements IPtyProvider {
  private current: DaemonPtyAdapter
  private legacy: DaemonPtyAdapter[]
  private sessionAdapters = new Map<string, DaemonPtyAdapter>()
  private unsubscribers: (() => void)[] = []
  private dataListeners: ((payload: { id: string; data: string }) => void)[] = []
  private exitListeners: ((payload: { id: string; code: number }) => void)[] = []

  constructor(opts: { current: DaemonPtyAdapter; legacy: DaemonPtyAdapter[] }) {
    this.current = opts.current
    this.legacy = opts.legacy

    for (const adapter of this.allAdapters()) {
      this.unsubscribers.push(
        adapter.onData((payload) => {
          for (const listener of this.dataListeners) {
            listener(payload)
          }
        }),
        adapter.onExit((payload) => {
          this.sessionAdapters.delete(payload.id)
          for (const listener of this.exitListeners) {
            listener(payload)
          }
        })
      )
    }
  }

  async discoverLegacySessions(): Promise<void> {
    for (const adapter of this.legacy) {
      try {
        const sessions = await adapter.listProcesses()
        for (const session of sessions) {
          this.sessionAdapters.set(session.id, adapter)
        }
      } catch (error) {
        console.warn('[daemon] Failed to discover legacy daemon sessions', error)
      }
    }
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const adapter = opts.sessionId ? this.sessionAdapters.get(opts.sessionId) : undefined
    const target = adapter ?? this.current
    const result = await target.spawn(opts)
    this.sessionAdapters.set(result.id, target)
    return result
  }

  async attach(id: string): Promise<void> {
    await this.adapterFor(id).attach(id)
  }

  write(id: string, data: string): void {
    this.adapterFor(id).write(id, data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.adapterFor(id).resize(id, cols, rows)
  }

  async shutdown(id: string, immediate: boolean): Promise<void> {
    await this.adapterFor(id).shutdown(id, immediate)
    this.sessionAdapters.delete(id)
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    await this.adapterFor(id).sendSignal(id, signal)
  }

  async getCwd(id: string): Promise<string> {
    return this.adapterFor(id).getCwd(id)
  }

  async getInitialCwd(id: string): Promise<string> {
    return this.adapterFor(id).getInitialCwd(id)
  }

  async clearBuffer(id: string): Promise<void> {
    await this.adapterFor(id).clearBuffer(id)
  }

  acknowledgeDataEvent(id: string, charCount: number): void {
    this.adapterFor(id).acknowledgeDataEvent(id, charCount)
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    return this.adapterFor(id).hasChildProcesses(id)
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    return this.adapterFor(id).getForegroundProcess(id)
  }

  async serialize(ids: string[]): Promise<string> {
    return this.current.serialize(ids)
  }

  async revive(state: string): Promise<void> {
    await this.current.revive(state)
  }

  async listProcesses(): Promise<{ id: string; cwd: string; title: string }[]> {
    const results = await Promise.allSettled(
      this.allAdapters().map((adapter) => adapter.listProcesses())
    )
    return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  }

  async getDefaultShell(): Promise<string> {
    return this.current.getDefaultShell()
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    return this.current.getProfiles()
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

  onReplay(_callback: (payload: { id: string; data: string }) => void): () => void {
    return () => {}
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
    this.adapterFor(sessionId).ackColdRestore(sessionId)
  }

  clearTombstone(sessionId: string): void {
    this.adapterFor(sessionId).clearTombstone(sessionId)
  }

  async reconcileOnStartup(validWorktreeIds: Set<string>): Promise<{
    alive: string[]
    killed: string[]
  }> {
    const alive: string[] = []
    const killed: string[] = []
    for (const adapter of this.allAdapters()) {
      const result = await adapter.reconcileOnStartup(validWorktreeIds)
      alive.push(...result.alive)
      killed.push(...result.killed)
      for (const id of result.alive) {
        this.sessionAdapters.set(id, adapter)
      }
      for (const id of result.killed) {
        this.sessionAdapters.delete(id)
      }
    }
    return { alive, killed }
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe()
    }
    for (const adapter of this.allAdapters()) {
      adapter.dispose()
    }
  }

  disconnectOnly(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe()
    }
    for (const adapter of this.allAdapters()) {
      adapter.disconnectOnly()
    }
  }

  private adapterFor(sessionId: string): DaemonPtyAdapter {
    return this.sessionAdapters.get(sessionId) ?? this.current
  }

  private allAdapters(): DaemonPtyAdapter[] {
    return [this.current, ...this.legacy]
  }
}
