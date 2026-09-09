import { DaemonRouterSessionCustody } from './daemon-router-session-custody'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION } from './types'
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
import type { DaemonPtyRouterDataEvent, DaemonPtyRouterExitEvent } from './daemon-pty-router-events'
import { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'
import type { WriteSettlement } from '../../shared/pty-write-settlement'

export class DaemonPtyRouter implements IPtyProvider {
  private readonly custody: DaemonRouterSessionCustody
  private readonly retirements = new Map<DaemonPtyAdapter, Promise<void>>()
  private disposed = false
  private current: DaemonPtyAdapter
  private legacy: DaemonPtyAdapter[]
  private sessionAdapters = new Map<string, DaemonPtyAdapter>()
  private readonly ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
  private readonly subscriptions: DaemonPtyAdapterSubscriptionFanout

  constructor(opts: { current: DaemonPtyAdapter; legacy: DaemonPtyAdapter[] }) {
    this.current = opts.current
    this.legacy = opts.legacy
    this.ownerResolver = new DaemonSessionOwnerResolver(this.allAdapters(), this.sessionAdapters)
    this.custody = new DaemonRouterSessionCustody(this.current, this.ownerResolver, (id) =>
      this.adapterFor(id)
    )
    this.subscriptions = new DaemonPtyAdapterSubscriptionFanout(
      this.allAdapters(),
      (id, adapter, incarnationId) => {
        if (!this.custody.releasingIds.has(id)) {
          void this.ownerResolver.authority
            .exited(id, adapter, incarnationId)
            .then(() => this.retireLegacyAdapter(adapter))
        }
      },
      (adapter) => this.ownerResolver.invalidateProvider(adapter)
    )
  }

  async discoverLegacySessions(): Promise<void> {
    await this.ownerResolver.discoverRoutes()
    await Promise.all(this.legacy.map((adapter) => this.retireLegacyAdapter(adapter)))
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    return opts.sessionId
      ? this.custody.run(opts.sessionId, (observation) => this.spawnWithCustody(opts, observation))
      : this.spawnWithCustody(opts)
  }

  private async spawnWithCustody(
    opts: PtySpawnOptions,
    observation = this.ownerResolver.authority.capture()
  ): Promise<PtySpawnResult> {
    if (opts.attachOnly && opts.sessionId) {
      return await this.ownerResolver.spawnAttachOnly(
        { ...opts, sessionId: opts.sessionId },
        observation
      )
    }
    const adapter = opts.sessionId ? this.sessionAdapters.get(opts.sessionId) : undefined
    const target = adapter ?? this.current
    const result = await target.spawn(opts)
    // Why: the adapter filters intentional recovery exits and canonical-ID races before publishing proof.
    if (!result.exitedBeforeSpawnReply) {
      await this.ownerResolver.publishSpawnResult(result, target, observation)
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

  async attach(id: string): ReturnType<IPtyProvider['attach']> {
    return this.custody.run(id, () => this.adapterFor(id).attach(id))
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

  writeWithSettlement(id: string, data: string): Promise<WriteSettlement> {
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
    const adapter = await this.custody.shutdown(id, opts)
    await this.retireLegacyAdapter(adapter)
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
    id: string,
    options?: { expectedIncarnationId?: string; steadyState?: boolean }
  ): Promise<PtyProcessInspection> {
    return this.adapterForInspection(id).inspectProcess(id, options)
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

  dispose(): void {
    this.disposed = true
    this.ownerResolver.authority.dispose()
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
    this.disposed = true
    this.ownerResolver.authority.dispose()
    this.subscriptions.dispose()
  }

  async disconnectOnly(): Promise<void> {
    this.disposed = true
    this.ownerResolver.authority.dispose()
    this.subscriptions.dispose()
    await Promise.all([...this.allAdapters()].map((adapter) => adapter.disconnectOnly()))
  }

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
    return adapter
  }

  private retireLegacyAdapter(adapter: DaemonPtyAdapter): Promise<void> {
    const pending = this.retirements.get(adapter)
    if (pending) {
      return pending
    }
    if (
      this.disposed ||
      adapter.protocolVersion < CLEAN_DISCONNECT_PROTOCOL_VERSION ||
      !this.legacy.includes(adapter) ||
      this.custody.releasing.has(adapter) ||
      [...this.sessionAdapters.values()].includes(adapter)
    ) {
      return Promise.resolve()
    }
    const retirement = (async () => {
      if (await adapter.retireIfIdle(this.current)) {
        this.ownerResolver.removeProvider(adapter)
        this.subscriptions.removeAdapter(adapter)
        this.legacy = this.legacy.filter((candidate) => candidate !== adapter)
        await adapter.disconnectOnly()
      }
    })().finally(() => this.retirements.delete(adapter))
    this.retirements.set(adapter, retirement)
    return retirement
  }

  private allAdapters(): DaemonPtyAdapter[] {
    return [this.current, ...this.legacy]
  }
}
