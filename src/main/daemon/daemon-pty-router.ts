import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type {
  IPtyProvider,
  PtyBackgroundStreamEvent,
  PtyProviderBufferSnapshot,
  PtyProcessInfo,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/types'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'

export class DaemonPtyRouter implements IPtyProvider {
  private current: DaemonPtyAdapter
  private legacy: DaemonPtyAdapter[]
  private sessionAdapters = new Map<string, DaemonPtyAdapter>()
  private unsubscribers: (() => void)[] = []
  private dataListeners: ((payload: {
    id: string
    data: string
    sequenceChars?: number
    transformed?: boolean
    seq?: number
  }) => void)[] = []
  private exitListeners: ((payload: {
    id: string
    code: number
    incarnationId?: PtyIncarnationId
  }) => void)[] = []

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
    // Why: the adapter filters intentional recovery exits and canonical-ID races before publishing proof.
    if (!result.exitedBeforeSpawnReply) {
      this.sessionAdapters.set(result.id, target)
    }
    return result
  }

  supportsGitCredentialGuardHost(sessionId?: string): boolean {
    const adapter = sessionId ? this.adapterFor(sessionId) : this.current
    return adapter.supportsGitCredentialGuardHost()
  }

  supportsAgentSessionClaims(): boolean {
    // Why: a legacy daemon may still own a resumable PTY, so authority requires every route.
    return this.allAdapters().every((adapter) => adapter.supportsAgentSessionClaims())
  }

  providesAgentSessionOwnerListings(ptyId: string): boolean {
    const adapter = this.sessionAdapters.get(ptyId)
    // Why: an unmapped id may belong to any preserved daemon generation;
    // only an established route can make an omitted owner authoritative.
    return adapter?.providesAgentSessionOwnerListings(ptyId) === true
  }

  supportsAgentSessionCreateOperations(): boolean {
    // Fresh sessions always route to the current daemon; legacy adapters only retain old IDs.
    return this.current.supportsAgentSessionCreateOperations()
  }

  async attach(id: string): Promise<void> {
    await this.adapterFor(id).attach(id)
  }

  hasPty(id: string): boolean {
    const routed = this.sessionAdapters.get(id)
    if (routed) {
      return routed.hasPty(id)
    }
    return this.current.hasPty(id) || this.legacy.some((adapter) => adapter.hasPty(id))
  }

  write(id: string, data: string): void {
    this.adapterFor(id).write(id, data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.adapterFor(id).resize(id, cols, rows)
  }

  pauseProducer(id: string): void {
    this.adapterFor(id).pauseProducer(id)
  }

  resumeProducer(id: string): void {
    this.adapterFor(id).resumeProducer(id)
  }

  setPtyBackgrounded(id: string, background: boolean): void {
    this.adapterFor(id).setPtyBackgrounded(id, background)
  }

  async shutdown(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<void> {
    await this.adapterFor(id).shutdown(id, opts)
    // Why: sleep passes keepHistory=true and re-spawns against the same
    // sessionId on wake. If we delete the routing entry here, adapterFor()
    // falls back to `this.current` on wake — for a session that originally
    // lived on a legacy adapter (different protocolVersion), the wake-side
    // createOrAttach lands on the wrong adapter and creates a fresh session,
    // losing the cold-restore from the legacy adapter's history dir.
    if (!opts.keepHistory) {
      this.sessionAdapters.delete(id)
    }
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

  async getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    return (await this.adapterFor(id).getAppliedSize?.(id)) ?? null
  }

  async getBufferSnapshot(
    id: string,
    opts?: { scrollbackRows?: number }
  ): Promise<PtyProviderBufferSnapshot | null> {
    return await this.adapterFor(id).getBufferSnapshot(id, opts)
  }

  canProvideAuthoritativeBufferSnapshot(id: string): boolean {
    return this.adapterFor(id).canProvideAuthoritativeBufferSnapshot(id)
  }

  async clearBuffer(id: string): Promise<void> {
    await this.adapterFor(id).clearBuffer(id)
  }

  async closeStartupQueryAuthority(id: string): Promise<number> {
    return (await this.adapterFor(id).closeStartupQueryAuthority?.(id)) ?? 0
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

  async inspectProcess(
    id: string
  ): Promise<{ foregroundProcess: string | null; hasChildProcesses: boolean }> {
    return this.adapterForInspection(id).inspectProcess(id)
  }

  async confirmForegroundProcess(id: string): Promise<string | null> {
    return this.adapterFor(id).confirmForegroundProcess(id)
  }

  async serialize(ids: string[]): Promise<string> {
    return this.current.serialize(ids)
  }

  async revive(state: string): Promise<void> {
    await this.current.revive(state)
  }

  async listProcesses(opts?: { deadlineMs?: number }): Promise<PtyProcessInfo[]> {
    // Why: runtime exact-stop/liveness flows must fail closed if any adapter
    // cannot provide a trustworthy process list.
    const results = await Promise.all(
      this.allAdapters().map((adapter) => adapter.listProcesses(opts))
    )
    return results.flat()
  }

  async getDefaultShell(): Promise<string> {
    return this.current.getDefaultShell()
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    return this.current.getProfiles()
  }

  onData(
    callback: (payload: {
      id: string
      data: string
      sequenceChars?: number
      transformed?: boolean
      seq?: number
    }) => void
  ): () => void {
    this.dataListeners.push(callback)
    return () => {
      const idx = this.dataListeners.indexOf(callback)
      if (idx !== -1) {
        this.dataListeners.splice(idx, 1)
      }
    }
  }

  onBackgroundStreamEvent(callback: (payload: PtyBackgroundStreamEvent) => void): () => void {
    const unsubscribes = this.allAdapters().map((adapter) =>
      adapter.onBackgroundStreamEvent(callback)
    )
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
    }
  }

  onReplay(_callback: (payload: { id: string; data: string }) => void): () => void {
    return () => {}
  }

  onExit(
    callback: (payload: { id: string; code: number; incarnationId?: PtyIncarnationId }) => void
  ): () => void {
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
      // Why: daemon startup can reconcile many restored sessions; spreading
      // those arrays into push can exceed JavaScript's argument limit.
      for (const id of result.alive) {
        alive.push(id)
      }
      for (const id of result.killed) {
        killed.push(id)
      }
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

  // Why: restart swaps to a fresh router carrying the *same* legacy adapter
  // instances. If we called dispose() on the outgoing router it would tear
  // down those legacy adapters along with it. disposeRouterOnly() detaches
  // only this router's subscriptions from the adapters — the adapters and
  // their daemon connections keep running, and the new router re-subscribes.
  // Without this, each restart leaked a router instance pinned by the legacy
  // adapters' listener arrays (one pair per adapter per restart).
  disposeRouterOnly(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe()
    }
  }

  async disconnectOnly(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe()
    }
    await Promise.all([...this.allAdapters()].map((adapter) => adapter.disconnectOnly()))
  }

  // Why: the Manage Sessions panel iterates all adapters to list sessions
  // across every protocol version, and the restart handler needs to preserve
  // surviving legacy adapters across the current-adapter swap. On this branch
  // (pre-#1323) the legacy list is set once at construction and never mutated,
  // so returning the internal array by reference is safe for the intended
  // read-only use.
  getCurrentAdapter(): DaemonPtyAdapter {
    return this.current
  }

  getLegacyAdapters(): readonly DaemonPtyAdapter[] {
    return this.legacy
  }

  getAllAdapters(): readonly DaemonPtyAdapter[] {
    return this.allAdapters()
  }

  private adapterFor(sessionId: string): DaemonPtyAdapter {
    return this.sessionAdapters.get(sessionId) ?? this.current
  }

  private adapterForInspection(sessionId: string): DaemonPtyAdapter {
    const adapter =
      this.sessionAdapters.get(sessionId) ??
      this.allAdapters().find((candidate) => candidate.hasPty(sessionId))
    if (!adapter) {
      throw new Error('terminal_gone')
    }
    this.sessionAdapters.set(sessionId, adapter)
    return adapter
  }

  private allAdapters(): DaemonPtyAdapter[] {
    return [this.current, ...this.legacy]
  }
}
