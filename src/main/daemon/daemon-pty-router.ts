import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyAdapterSubscriptionFanout } from './daemon-pty-adapter-subscription-fanout'
import type {
  IPtyProvider,
  PtyBackgroundStreamEvent,
  PtyProviderBufferSnapshot,
  PtyProcessInfo,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/types'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'
import { shouldHandoffDaemonHistory } from './daemon-history-handoff'
import type { DaemonPtyRouterDataEvent, DaemonPtyRouterExitEvent } from './daemon-pty-router-events'
import { DaemonPtyRouterSessionRouting } from './daemon-pty-router-session-routing'
import { sameDaemonIncarnation } from './daemon-session-route'

export class DaemonPtyRouter implements IPtyProvider {
  private current: DaemonPtyAdapter
  private legacy: DaemonPtyAdapter[]
  private readonly routing: DaemonPtyRouterSessionRouting
  private readonly subscriptions: DaemonPtyAdapterSubscriptionFanout

  constructor(opts: { current: DaemonPtyAdapter; legacy: DaemonPtyAdapter[] }) {
    this.current = opts.current
    this.legacy = opts.legacy
    this.routing = new DaemonPtyRouterSessionRouting(this.current, this.allAdapters())
    this.subscriptions = new DaemonPtyAdapterSubscriptionFanout(
      this.allAdapters(),
      (adapter, id) => this.routing.shouldForwardStreamEvent(id, adapter),
      (adapter, id) => this.routing.shouldForwardWriteUnavailable(id, adapter),
      (adapter, id) => this.routing.recordExit(id, adapter)
    )
  }

  markAdapterRoutesUnavailable(adapter: DaemonPtyAdapter): void {
    this.routing.markAdapterUnavailable(adapter)
  }

  getSessionRouteState(sessionId: string): 'owned' | 'unavailable' | 'ambiguous' | null {
    return this.routing.getRouteState(sessionId)
  }

  private allAdapters(): DaemonPtyAdapter[] {
    return [this.current, ...this.legacy]
  }

  async discoverLegacySessions(): Promise<void> {
    for (const adapter of this.legacy) {
      try {
        const before = adapter.getLastAuthenticatedDaemonIdentity()
        const sessions = await adapter.listProcesses()
        const incarnation = adapter.getLastAuthenticatedDaemonIdentity()
        if (before && !sameDaemonIncarnation(before, incarnation)) {
          throw new Error('daemon incarnation changed during session discovery')
        }
        this.routing.recordDiscovery(adapter, sessions, incarnation)
      } catch (error) {
        this.routing.recordDiscoveryFailure(adapter)
        console.warn('[daemon] Failed to discover legacy daemon sessions', error)
      }
    }
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const targetResult = this.routing.spawnTarget(opts)
    const target = targetResult instanceof Promise ? await targetResult : targetResult
    const authoritativeIntent = this.routing.beginSpawn(opts, target)
    try {
      const result = await target.spawn(opts)
      this.routing.recordSpawn(result, target, opts, authoritativeIntent)
      return result
    } finally {
      this.routing.endSpawn(opts, authoritativeIntent)
    }
  }

  supportsGitCredentialGuardHost(sessionId?: string): boolean {
    const owner = sessionId ? this.routing.ownerForHint(sessionId) : this.current
    return owner?.supportsGitCredentialGuardHost() ?? false
  }

  supportsAgentSessionClaims(): boolean {
    // Why: a legacy daemon may still own a resumable PTY, so authority requires every route.
    return this.allAdapters().every((adapter) => adapter.supportsAgentSessionClaims())
  }

  providesAgentSessionOwnerListings(ptyId: string): boolean {
    // Why: an unmapped id may belong to any preserved daemon generation;
    // only an established route can make an omitted owner authoritative.
    return this.routing.providesAgentSessionOwnerListings(ptyId)
  }

  supportsAgentSessionCreateOperations(): boolean {
    // Fresh sessions always route to the current daemon; legacy adapters only retain old IDs.
    return this.current.supportsAgentSessionCreateOperations()
  }

  async attach(id: string): Promise<void> {
    await (await this.routing.owner(id)).attach(id)
  }

  hasPty(id: string): boolean {
    return this.routing.hasPty(id)
  }

  async probePtyLiveness(id: string): Promise<boolean | null> {
    return await this.routing.probePtyLiveness(id)
  }

  write(id: string, data: string): void {
    this.routing.ownerSync(id).write(id, data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.routing.ownerSync(id).resize(id, cols, rows)
  }

  pauseProducer(id: string): void {
    this.routing.ownerForHint(id)?.pauseProducer(id)
  }

  resumeProducer(id: string): void {
    this.routing.ownerForHint(id)?.resumeProducer(id)
  }

  setPtyBackgrounded(id: string, background: boolean): void {
    this.routing.ownerForHint(id)?.setPtyBackgrounded(id, background)
  }

  async shutdown(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<void> {
    const adapter = await this.routing.owner(id)
    const migrateHistory = shouldHandoffDaemonHistory(opts.keepHistory, adapter, this.current)
    await adapter.shutdown(id, opts)
    if (migrateHistory) {
      adapter.ackColdRestore(id)
    }
    this.routing.recordShutdown(id, adapter, opts.keepHistory, migrateHistory)
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    await (await this.routing.owner(id)).sendSignal(id, signal)
  }

  async getCwd(id: string): Promise<string> {
    return (await this.routing.owner(id)).getCwd(id)
  }

  async getInitialCwd(id: string): Promise<string> {
    return (await this.routing.owner(id)).getInitialCwd(id)
  }

  async getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    return (await (await this.routing.owner(id)).getAppliedSize?.(id)) ?? null
  }

  async getBufferSnapshot(
    id: string,
    opts?: { scrollbackRows?: number }
  ): Promise<PtyProviderBufferSnapshot | null> {
    return await this.routing.getBufferSnapshot(id, opts)
  }

  canProvideAuthoritativeBufferSnapshot(id: string): boolean {
    return this.routing.canProvideAuthoritativeBufferSnapshot(id)
  }

  async clearBuffer(id: string): Promise<void> {
    await (await this.routing.owner(id)).clearBuffer(id)
  }

  async closeStartupQueryAuthority(id: string): Promise<number> {
    return (await (await this.routing.owner(id)).closeStartupQueryAuthority?.(id)) ?? 0
  }

  acknowledgeDataEvent(id: string, charCount: number): void {
    this.routing.ownerSync(id).acknowledgeDataEvent(id, charCount)
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    return (await this.routing.owner(id)).hasChildProcesses(id)
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    return (await this.routing.owner(id)).getForegroundProcess(id)
  }

  async inspectProcess(id: string): Promise<PtyProcessInspection> {
    return (await this.routing.owner(id)).inspectProcess(id)
  }

  async confirmForegroundProcess(id: string): Promise<string | null> {
    return (await this.routing.owner(id)).confirmForegroundProcess(id)
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

  onData(callback: (payload: DaemonPtyRouterDataEvent) => void): () => void {
    return this.subscriptions.onData(callback)
  }

  onBackgroundStreamEvent(callback: (payload: PtyBackgroundStreamEvent) => void): () => void {
    return this.subscriptions.onBackgroundStreamEvent(callback)
  }

  onWriteUnavailable(callback: (payload: { id: string }) => void): () => void {
    return this.subscriptions.onWriteUnavailable(callback)
  }

  onReplay(callback: (payload: { id: string; data: string }) => void): () => void {
    return this.subscriptions.onReplay(callback)
  }

  onExit(callback: (payload: DaemonPtyRouterExitEvent) => void): () => void {
    return this.subscriptions.onExit(callback)
  }

  ackColdRestore(sessionId: string): void {
    this.routing.acknowledgeBufferSnapshot(sessionId)
  }

  clearTombstone(sessionId: string): void {
    this.routing.clearAdapterTombstone(sessionId)
  }

  async reconcileOnStartup(validWorktreeIds: Set<string>): Promise<{
    alive: string[]
    killed: string[]
  }> {
    const alive: string[] = []
    const killed: string[] = []
    const reconciled: {
      adapter: DaemonPtyAdapter
      incarnation: ReturnType<DaemonPtyAdapter['getLastAuthenticatedDaemonIdentity']>
      alive: string[]
      killed: string[]
    }[] = []
    for (const adapter of this.allAdapters()) {
      const before = adapter.getLastAuthenticatedDaemonIdentity()
      const result = await adapter.reconcileOnStartup(validWorktreeIds)
      const incarnation = adapter.getLastAuthenticatedDaemonIdentity()
      if (before && !sameDaemonIncarnation(before, incarnation)) {
        this.routing.markAdapterUnavailable(adapter, before)
        throw new Error('daemon incarnation changed during startup reconciliation')
      }
      reconciled.push({ adapter, incarnation, ...result })
      // Why: daemon startup can reconcile many restored sessions; spreading
      // those arrays into push can exceed JavaScript's argument limit.
      for (const id of result.alive) {
        alive.push(id)
      }
      for (const id of result.killed) {
        killed.push(id)
      }
    }
    for (const { adapter, incarnation } of reconciled) {
      if (!sameDaemonIncarnation(incarnation, adapter.getLastAuthenticatedDaemonIdentity())) {
        this.routing.markAdapterUnavailable(adapter, incarnation)
        throw new Error('daemon incarnation changed during startup reconciliation')
      }
    }
    for (const { adapter, incarnation, alive: sessionIds } of reconciled) {
      for (const id of sessionIds) {
        this.routing.recordReconciledAlive(id, adapter, incarnation)
      }
    }
    for (const { adapter, incarnation, killed: sessionIds } of reconciled) {
      for (const id of sessionIds) {
        this.routing.recordReconciledKilled(id, adapter, incarnation)
      }
    }
    return { alive, killed }
  }

  dispose(): void {
    this.subscriptions.dispose()
    this.routing.dispose()
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
    this.subscriptions.dispose()
    this.routing.dispose()
  }

  async disconnectOnly(): Promise<void> {
    this.subscriptions.dispose()
    this.routing.dispose()
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
}
