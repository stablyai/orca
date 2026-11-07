import { DaemonPtyTargetInspection } from './daemon-pty-target-inspection'
import { terminateResolvedDaemonSession } from '../../server/daemon-fenced-termination'
import type { PtyFencedTerminationRequest } from '../../../../shared/terminal/pty/lifecycle/pty-fenced-termination'
import { reconcileDaemonRouterSessions } from './daemon-router-session-reconciliation'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type {
  IPtyProvider,
  PtyBackgroundStreamEvent,
  PtyProviderBufferSnapshot,
  PtySpawnOptions,
  PtySpawnResult
} from '../../../providers/pty-provider-contract'
import type { TerminalProcessInspection as PtyProcessInspection } from '../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import { LegacyDaemonExitProof } from './daemon-legacy-exit-proof'
import { shutdownRoutedDaemonSession } from './daemon-routed-session-shutdown'
import type {
  DaemonPtyRouterDataEvent,
  DaemonPtyRouterExitEvent
} from '../../protocol/daemon-pty-router-events'
import { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'
import type { DaemonIdleRetirementResult } from '../adapter/daemon-pty-runtime-state'
import { DaemonRouterRetirement } from './daemon-router-retirement'
import { routeSpawnOrHold } from './daemon-router-newer-daemon-hold'
import { findLegacySessionOwner } from './daemon-router-legacy-owner'
import { createLegacyDrainFanout } from './daemon-legacy-drain-retirement'
import { retireExitedLegacyAdapter, type ExitedLegacyVerdict } from './daemon-router-exited-legacy'
import type { WriteSettlement } from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal/protocol/queries/terminal-osc-color-reply'

export class DaemonPtyRouter implements IPtyProvider {
  private current: DaemonPtyAdapter
  private legacy: DaemonPtyAdapter[]
  private sessionAdapters = new Map<string, DaemonPtyAdapter>()
  private readonly targetInspection: DaemonPtyTargetInspection
  private readonly ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
  private readonly legacyDrain: ReturnType<typeof createLegacyDrainFanout>
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
    this.targetInspection = new DaemonPtyTargetInspection(
      this.allAdapters,
      this.sessionAdapters,
      (id) => this.ownerResolver.getRouteIncarnation(id)
    )
    this.legacyDrain = createLegacyDrainFanout({
      adapters: this.allAdapters(),
      legacy: this.legacy,
      sessionAdapters: this.sessionAdapters,
      ownerResolver: this.ownerResolver
    })
    this.legacyExitProof.record(this.legacy)
  }

  /** Resolves live sessions across generations and sweeps any generation the inventory proves empty. */
  async discoverLegacySessions(): Promise<void> {
    await this.ownerResolver.discoverRoutes()
    this.legacyExitProof.record(this.legacy)
    // Why: generations that drained while no app was running have no exit event to react to.
    this.legacyDrain.drain.sweepDrainedLegacyAdapters(this.legacy)
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

  reportFocusLost = async (id: string): Promise<void> => this.adapterFor(id).reportFocusLost?.(id)

  async closeStartupQueryAuthority(id: string): Promise<number> {
    return (await this.adapterFor(id).closeStartupQueryAuthority?.(id)) ?? 0
  }

  setColorQueryReplyColors(colors: TerminalOscColorQueryReplyColors): void {
    this.allAdapters().forEach((adapter) => adapter.setColorQueryReplyColors(colors))
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

  supportsForegroundObservation(id: string): boolean {
    return this.targetInspection.supportsForegroundObservation(id)
  }

  async inspectProcess(
    id: string,
    options?: Parameters<DaemonPtyAdapter['inspectProcess']>[1]
  ): Promise<PtyProcessInspection> {
    return this.targetInspection.inspectProcess(id, options)
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
    // Only an established route skips owner resolution; everyone else keeps complete-inventory proof.
    if (opts?.targetOwnerOnly && opts.ptyIds?.every((id) => this.sessionAdapters.has(id))) {
      return this.targetInspection.listProcesses(opts.ptyIds, opts)
    }
    const processes = await this.ownerResolver.listProcesses(opts)
    this.legacyExitProof.record(this.legacy)
    return processes
  }

  private retireExitedLegacy(adapter: DaemonPtyAdapter, error: unknown): ExitedLegacyVerdict {
    const { current, legacy, legacyExitProof: exitProof, legacyDrain } = this
    return retireExitedLegacyAdapter({
      adapter,
      error,
      current,
      legacy,
      exitProof,
      subscriptions: legacyDrain.fanout
    })
  }

  async getDefaultShell(): Promise<string> {
    return this.current.getDefaultShell()
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    return this.current.getProfiles()
  }

  onData = (callback: (payload: DaemonPtyRouterDataEvent) => void): (() => void) =>
    this.legacyDrain.fanout.onData(callback)

  onBackgroundStreamEvent = (callback: (payload: PtyBackgroundStreamEvent) => void): (() => void) =>
    this.legacyDrain.fanout.onBackgroundStreamEvent(callback)

  onWriteUnavailable = (callback: (payload: { id: string }) => void): (() => void) =>
    this.legacyDrain.fanout.onWriteUnavailable(callback)

  onReplay = (callback: (payload: { id: string; data: string }) => void): (() => void) =>
    this.legacyDrain.fanout.onReplay(callback)

  onExit = (callback: (payload: DaemonPtyRouterExitEvent) => void): (() => void) =>
    this.legacyDrain.fanout.onExit(callback)

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

  /** Tears down drain checks, subscriptions, and every adapter (full shutdown path). */
  dispose(): void {
    this.legacyDrain.drain.dispose()
    this.legacyDrain.fanout.dispose()
    for (const adapter of this.allAdapters()) {
      adapter.dispose()
    }
  }

  /** Detaches only this router's subscriptions (dispose() would tear adapters down); restart reuses them. */
  disposeRouterOnly(): void {
    this.legacyDrain.drain.dispose()
    this.legacyDrain.fanout.dispose()
  }

  async disconnectOnly(): Promise<void> {
    this.legacyDrain.fanout.dispose()
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

  private allAdapters = (): DaemonPtyAdapter[] => [this.current, ...this.legacy]
}
