import { terminateResolvedDaemonSession } from './daemon-fenced-termination'
import type { PtyFencedTerminationRequest } from '../../shared/pty-fenced-termination'
import { reconcileDaemonRouterSessions } from './daemon-router-session-reconciliation'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyAdapterSubscriptionFanout } from './daemon-pty-adapter-subscription-fanout'
import type {
  IPtyProvider,
  PtyBackgroundStreamEvent,
  PtyProviderBufferSnapshot,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/pty-provider-contract'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'
import { LegacyDaemonExitProof } from './daemon-legacy-exit-proof'
import { shutdownRoutedDaemonSession } from './daemon-routed-session-shutdown'
import type { DaemonPtyRouterDataEvent, DaemonPtyRouterExitEvent } from './daemon-pty-router-events'
import { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'
import type { DaemonIdleRetirementResult } from './daemon-pty-runtime-state'
import { DaemonRouterRetirement } from './daemon-router-retirement'
import { routeSpawnOrHold } from './daemon-router-newer-daemon-hold'
import { findLegacySessionOwner } from './daemon-router-legacy-owner'
import { retireExitedLegacyAdapter, type ExitedLegacyVerdict } from './daemon-router-exited-legacy'
import type { WriteSettlement } from '../../shared/pty-write-settlement'
import type { TerminalOscColorQueryReplyColors } from '../../shared/terminal-osc-color-reply'

export class DaemonPtyRouter implements IPtyProvider {
  private current: DaemonPtyAdapter
  private legacy: DaemonPtyAdapter[]
  private sessionAdapters = new Map<string, DaemonPtyAdapter>()
  private readonly ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
  private readonly subscriptions: DaemonPtyAdapterSubscriptionFanout
  private readonly legacyExitProof = new LegacyDaemonExitProof()
  readonly retirement = new DaemonRouterRetirement(() => this.allAdapters())

  constructor(opts: { current: DaemonPtyAdapter; legacy: DaemonPtyAdapter[] }) {
    this.current = opts.current
    this.legacy = opts.legacy
    for (const adapter of this.allAdapters()) {
      // A close that finds no session asks every daemon this router knows before ending history.
      if (typeof adapter.shareSessionListingWith === 'function') {
        adapter.shareSessionListingWith(() => this.allAdapters())
      }
    }
    this.ownerResolver = new DaemonSessionOwnerResolver(
      this.allAdapters(),
      this.sessionAdapters,
      (adapter, error) => this.retireExitedLegacy(adapter, error) !== 'not-exited'
    )
    this.subscriptions = new DaemonPtyAdapterSubscriptionFanout(
      this.allAdapters(),
      // Another generation's exit for a reused ID must not unroute its live owner.
      (id, adapter) => {
        this.ownerResolver.forgetRoute(id, adapter)
      },
      (adapter) => this.ownerResolver.invalidateProvider(adapter)
    )
    this.legacyExitProof.record(this.legacy)
  }

  async discoverLegacySessions(): Promise<void> {
    await this.ownerResolver.discoverRoutes()
    this.legacyExitProof.record(this.legacy)
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    if (this.retirement.admissionClosed) {
      throw new Error('Terminal daemon is decommissioning')
    }
    // Retirement census must account for spawns that have not published their sessions yet.
    this.retirement.spawnInFlight++
    try {
      if (opts.attachOnly && opts.sessionId) {
        return await this.ownerResolver.spawnAttachOnly({ ...opts, sessionId: opts.sessionId })
      }
      const adapter =
        (opts.sessionId ? this.sessionAdapters.get(opts.sessionId) : undefined) ??
        (await findLegacySessionOwner(opts, this.current, this.legacy, this.legacyExitProof))
      const target = await routeSpawnOrHold(opts, adapter, this.current, this.ownerResolver)
      const result = await target.spawn(opts)
      if (!result.exitedBeforeSpawnReply) {
        this.ownerResolver.recordRoute(result.id, target, result.incarnationId)
      }
      return result
    } finally {
      this.retirement.spawnInFlight--
    }
  }

  requestIdleRetirement(): Promise<DaemonIdleRetirementResult> {
    return this.retirement.requestIdleRetirement()
  }

  releaseIdleRetirementFence(): void {
    this.retirement.releaseFence()
  }

  supportsGitCredentialGuardHost(sessionId?: string): boolean {
    const adapter = sessionId ? this.adapterFor(sessionId) : this.current
    return adapter.supportsGitCredentialGuardHost()
  }

  supportsAgentSessionClaims(): boolean {
    // Resumable PTYs can belong to legacy generations, so every route must support claims.
    return this.allAdapters().every((adapter) => adapter.supportsAgentSessionClaims())
  }

  providesAgentSessionOwnerListings(ptyId: string): boolean {
    // Unknown routes cannot make omitted owners authoritative; a preserved daemon may still own the ID.
    return (
      this.ownerResolver.getVerifiedRoute(ptyId)?.providesAgentSessionOwnerListings?.(ptyId) ===
      true
    )
  }

  supportsFencedTermination(id: string): boolean {
    return this.ownerResolver.getVerifiedRoute(id)?.supportsFencedTermination?.(id) === true
  }

  killFenced = (request: PtyFencedTerminationRequest) =>
    terminateResolvedDaemonSession(request, () =>
      this.ownerResolver.resolveTermination(request.id, request.expectedIncarnationId)
    )

  supportsAgentSessionCreateOperations(): boolean {
    // New sessions route to current; legacy adapters retain existing IDs.
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

  getPtyAvailability(id: string): boolean | null {
    return this.adapterFor(id).getPtyAvailability(id)
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

  shutdown = (id: string, opts: Parameters<IPtyProvider['shutdown']>[1]) =>
    shutdownRoutedDaemonSession(
      id,
      opts,
      this.adapterFor(id),
      this.current,
      this.sessionAdapters,
      this.ownerResolver
    )

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

  async resetInputModes(id: string): Promise<void> {
    await this.adapterFor(id).resetInputModes(id)
  }

  async closeStartupQueryAuthority(id: string): Promise<number> {
    return (await this.adapterFor(id).closeStartupQueryAuthority?.(id)) ?? 0
  }

  setColorQueryReplyColors(colors: TerminalOscColorQueryReplyColors): void {
    for (const adapter of this.allAdapters()) {
      adapter.setColorQueryReplyColors(colors)
    }
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
    options?: Parameters<DaemonPtyAdapter['inspectProcess']>[1]
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

  async listProcesses(opts?: Parameters<IPtyProvider['listProcesses']>[0]) {
    const processes = await this.ownerResolver.listProcesses(opts)
    this.legacyExitProof.record(this.legacy)
    return processes
  }

  private retireExitedLegacy(adapter: DaemonPtyAdapter, error: unknown): ExitedLegacyVerdict {
    const { current, legacy, legacyExitProof: exitProof, subscriptions } = this
    return retireExitedLegacyAdapter({ adapter, error, current, legacy, exitProof, subscriptions })
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

  async reconcileOnStartup(
    validWorktreeIds: Set<string>
  ): Promise<{ alive: string[]; killed: string[] }> {
    return reconcileDaemonRouterSessions(this.allAdapters(), this.ownerResolver, validWorktreeIds)
  }

  dispose(): void {
    this.subscriptions.dispose()
    for (const adapter of this.allAdapters()) {
      adapter.dispose()
    }
  }

  // Restart reuses legacy adapters; detach subscriptions without disposing those adapters.
  disposeRouterOnly(): void {
    this.subscriptions.dispose()
  }

  async disconnectOnly(): Promise<void> {
    this.subscriptions.dispose()
    await Promise.all([...this.allAdapters()].map((adapter) => adapter.disconnectOnly()))
  }

  getCurrentAdapter(): DaemonPtyAdapter {
    return this.current
  }

  // Preserve array identity while removing exited legacy adapters in place.
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

  private allAdapters = (): DaemonPtyAdapter[] => [this.current, ...this.legacy]
}
