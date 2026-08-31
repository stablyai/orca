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
import type { TuiAgent } from '../../shared/tui-agent'
import { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

export class DaemonPtyRouter implements IPtyProvider {
  private current: DaemonPtyAdapter
  private legacy: DaemonPtyAdapter[]
  private sessionAdapters = new Map<string, DaemonPtyAdapter>()
  private readonly ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
  private readonly subscriptions: DaemonPtyAdapterSubscriptionFanout

  constructor(opts: { current: DaemonPtyAdapter; legacy: DaemonPtyAdapter[] }) {
    this.current = opts.current
    this.legacy = opts.legacy
    this.ownerResolver = new DaemonSessionOwnerResolver(this.allAdapters(), this.sessionAdapters)
    this.subscriptions = new DaemonPtyAdapterSubscriptionFanout(
      this.allAdapters(),
      (id) => {
        this.ownerResolver.forgetRoute(id)
      },
      (adapter) => this.ownerResolver.invalidateProvider(adapter)
    )
  }

  async discoverLegacySessions(): Promise<void> {
    await this.ownerResolver.discoverRoutes()
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    if (opts.attachOnly && opts.sessionId) {
      return await this.ownerResolver.spawnAttachOnly({ ...opts, sessionId: opts.sessionId })
    }
    const adapter = opts.sessionId ? this.sessionAdapters.get(opts.sessionId) : undefined
    const target = adapter ?? this.current
    const result = await target.spawn(opts)
    // Why: the adapter filters intentional recovery exits and canonical-ID races before publishing proof.
    if (!result.exitedBeforeSpawnReply) {
      this.ownerResolver.recordRoute(result.id, target, result.incarnationId)
    }
    return result
  }

  supportsGitCredentialGuardHost(sessionId?: string): boolean {
    const adapter = sessionId ? this.adapterFor(sessionId) : this.current
    return adapter.supportsGitCredentialGuardHost()
  }

  supportsWorkerAuthorityIsolation(agent: TuiAgent): boolean {
    return this.current.supportsWorkerAuthorityIsolation(agent)
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

  async attach(id: string): ReturnType<IPtyProvider['attach']> {
    return await this.adapterFor(id).attach(id)
  }

  hasPty(id: string): boolean {
    const routed = this.sessionAdapters.get(id)
    if (routed) {
      return routed.hasPty(id)
    }
    return this.current.hasPty(id) || this.legacy.some((adapter) => adapter.hasPty(id))
  }

  async probePtyLiveness(id: string): Promise<boolean | null> {
    return await this.ownerResolver.probe(id)
  }

  write(id: string, data: string): boolean {
    return this.adapterFor(id).write(id, data)
  }

  writeWithSettlement(id: string, data: string): Promise<boolean> {
    return this.adapterFor(id).writeWithSettlement(id, data)
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
    const adapter = this.adapterFor(id)
    const migrateHistory = shouldHandoffDaemonHistory(opts.keepHistory, adapter, this.current)
    await adapter.shutdown(id, opts)
    if (!opts.keepHistory || migrateHistory) {
      if (migrateHistory) {
        adapter.ackColdRestore(id)
      }
      if (this.sessionAdapters.get(id) === adapter) {
        this.ownerResolver.forgetRoute(id, adapter)
      }
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

  async inspectProcess(id: string): Promise<PtyProcessInspection> {
    return this.adapterForInspection(id).inspectProcess(id)
  }

  async confirmForegroundProcess(id: string): Promise<string | null> {
    return this.adapterFor(id).confirmForegroundProcess(id)
  }

  async confirmShellForeground(id: string): Promise<boolean> {
    return (await this.adapterFor(id).confirmShellForeground?.(id)) ?? false
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
    const aliveProviders = new Map<string, Set<DaemonPtyAdapter>>()
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
        const providers = aliveProviders.get(id) ?? new Set<DaemonPtyAdapter>()
        providers.add(adapter)
        aliveProviders.set(id, providers)
      }
    }
    for (const id of new Set([...alive, ...killed])) {
      const providers = aliveProviders.get(id)
      if (providers?.size === 1) {
        this.ownerResolver.recordRoute(id, providers.values().next().value!)
      } else {
        this.ownerResolver.forgetRoute(id)
      }
    }
    return { alive, killed }
  }

  dispose(): void {
    this.subscriptions.dispose()
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
  }

  async disconnectOnly(): Promise<void> {
    this.subscriptions.dispose()
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
