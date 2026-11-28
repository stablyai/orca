import type { RexFreshReservation } from './rex-fresh-intent'
import { recoverRexFreshIntents } from './rex-fresh-recovery'
import { RexSessionCapacityError } from './rex-rpc-rejection'
import { writeRefused } from '../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import { validateRexFreshLaunch, validateRexShutdown } from './rex-fresh-validation'
import { userInfo } from 'node:os'
import type { RexLaunchPayloadFactory } from './rex-launch-worker'
import type { IPtyProvider, PtySpawnOptions } from '../pty/provider-contract'
import type { PtySpawnResult } from '../pty/spawn-result'
import type { PtyProcessInfo } from '../pty/process-info'
import { RexReclaimingPtyProvider } from './rex-reclaiming-pty-provider'
import type { RexSessionStore } from './rex-session-store'
import { retireRexSession } from './rex-close-block'
import { rexTerm, type RexFreshSession } from './rex-fresh-session'
import type { RexSnapshotDecoder } from './rex-reattach'
import { RexProcessInspector } from './rex-process-inspection'
import type { PtyProcessInspectionOptions } from '../pty/process-inspection'
import { mintRexPtyId, rexLocalPtyId } from './rex-session-record'
import { listRexProcesses } from './rex-process-inventory'
import { getRexShellProfiles } from './rex-shell-profiles'

/** Live-only native terminal provider. Named sessions never fall back to fresh spawn. */
export class RexPtyProvider extends RexReclaimingPtyProvider implements IPtyProvider {
  readonly ownsTerminalQueryReplies = true as const
  private readonly inspector: RexProcessInspector
  private readonly spawning = new Set<string>()
  private readonly queuedWrites = new Map<string, number>()

  constructor(
    endpoint: string,
    records: RexSessionStore,
    decode: RexSnapshotDecoder,
    preparePayload?: RexLaunchPayloadFactory
  ) {
    super(endpoint, records, decode, preparePayload)
    this.inspector = new RexProcessInspector(endpoint, records)
  }

  override async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    await this.snapshotDecoder.validateArtifact?.()
    if (opts.attachOnly || (opts.sessionId && opts.isNewSession !== true)) {
      if (!opts.sessionId || opts.signal?.aborted) {
        throw new Error('Rex attach identity unavailable')
      }
      await this.recoverFresh([opts.sessionId])
      const record = await this.store.read(opts.sessionId, opts.expectedIncarnationId)
      if (
        (opts.worktreeId && record.worktreeId !== opts.worktreeId) ||
        (opts.paneKey && record.paneKey !== opts.paneKey)
      ) {
        throw new Error('Rex attach pane/workspace mismatch')
      }
      return this.attachRecorded(record.id, record.incarnationId, opts.signal)
    }
    validateRexFreshLaunch(opts)
    const id = rexLocalPtyId.parse(opts.sessionId ?? mintRexPtyId(opts.worktreeId))
    if (this.spawning.has(id) || this.hasPty(id)) {
      throw new Error('Rex PTY already exists')
    }
    this.spawning.add(id)
    let reservation: RexFreshReservation | undefined
    let attempted = false
    try {
      await this.recoverFresh([id])
      if (await this.store.atCapacity()) {
        await this.recoverFresh()
        await this.reclaimCapacity()
      }
      const reserved = await this.store.reserveFresh(id)
      reservation = reserved
      const result = await super.spawn(
        { ...opts, sessionId: id, isNewSession: true },
        async (evidence) => {
          await reserved.markDispatch(evidence)
          attempted = true
        },
        (incarnation) => reserved.markReleased(incarnation)
      )
      await reserved.release()
      return result
    } catch (error) {
      // Before native dispatch the reservation is safely releasable. Any
      // possible dispatch stays fenced across controllers and restarts.
      if (!attempted || error instanceof RexSessionCapacityError) {
        await reservation?.release()
      }
      throw error
    } finally {
      this.spawning.delete(id)
      this.scheduleExitedSession(id)
    }
  }

  protected override onNaturalExit(session: RexFreshSession): void {
    if (!this.spawning.has(session.id)) {
      super.onNaturalExit(session)
    }
  }

  private attachRecorded(
    id: string,
    incarnation: string,
    signal?: AbortSignal
  ): Promise<PtySpawnResult> {
    return this.pendingRestore.serializeAttach(id, signal, () =>
      this.captureRecorded(id, incarnation)
    )
  }

  private async captureRecorded(id: string, incarnation: string): Promise<PtySpawnResult> {
    const record = await this.store.read(id, incarnation)
    await this.store.retirements.assertAvailable(record)
    if (record.adopted || record.backend !== 'rex-local') {
      throw new Error('External Rex record cannot use managed provider')
    }
    const existing = this.sessions.get(id)
    if (existing) {
      if (existing.record.incarnationId !== incarnation || existing.closing) {
        throw new Error('Rex active incarnation mismatch')
      }
      if (!existing.control.isClosed) {
        return this.captureActive(id)
      }
      await this.detach(id)
    }
    return this.restore(id, incarnation, this.snapshotDecoder)
  }

  async attach(id: string): Promise<PtySpawnResult> {
    await this.snapshotDecoder.validateArtifact?.()
    await this.recoverFresh([id])
    const record = await this.store.read(id)
    return this.attachRecorded(id, record.incarnationId)
  }

  override writeWithSettlement(id: string, data: string) {
    if (this.spawning.has(id)) {
      return Promise.resolve(writeRefused('provider_unavailable'))
    }
    return super.writeWithSettlement(id, data)
  }

  override resize(id: string, cols: number, rows: number): void {
    if (!this.spawning.has(id)) {
      super.resize(id, cols, rows)
    }
  }

  write(id: string, data: string): boolean {
    const session = this.sessions.get(id)
    const size = Buffer.byteLength(data)
    const queued = this.queuedWrites.get(id) ?? 0
    if (
      !this.canInteract(session) ||
      this.spawning.has(id) ||
      session.exitCode !== undefined ||
      size > 1024 * 1024 ||
      queued + size > 2 * 1024 * 1024
    ) {
      return false
    }
    this.queuedWrites.set(id, queued + size)
    void this.writeWithSettlement(id, data)
      .then(
        (result) => {
          if (result.outcome !== 'accepted') {
            this.markLost(session)
          }
        },
        () => this.markLost(session)
      )
      .finally(() => {
        const remaining = (this.queuedWrites.get(id) ?? size) - size
        if (remaining > 0) {
          this.queuedWrites.set(id, remaining)
        } else {
          this.queuedWrites.delete(id)
        }
      })
    return true
  }

  override async getInitialCwd(id: string): Promise<string> {
    return (await this.store.read(id)).cwd
  }

  async getCwd(id: string): Promise<string> {
    const entry = (await this.listProcesses({ ptyIds: [id] }))[0]
    if (!entry) {
      throw new Error('Rex cwd unavailable')
    }
    return entry.cwd
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    return (await this.listProcesses({ ptyIds: [id] }))[0]?.foregroundProcess ?? null
  }

  supportsForegroundObservation = () => true

  inspectProcess(id: string, opts?: PtyProcessInspectionOptions) {
    return this.inspector.inspect(id, opts)
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    return (await this.inspectProcess(id)).hasChildProcesses
  }

  async confirmForegroundProcess(id: string): Promise<string | null> {
    return (await this.inspectProcess(id, { foregroundOnly: true })).foregroundProcess
  }

  async confirmShellForeground(id: string): Promise<boolean> {
    const observation = (await this.inspectProcess(id, { foregroundOnly: true }))
      .foregroundObservation
    return observation?.verdict === 'observed' && observation.foregroundKind === 'shell'
  }

  async clearBuffer(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!this.canInteract(session) || this.spawning.has(id)) {
      throw new Error('Rex buffer unavailable')
    }
    await rexTerm(session, 'clear')
  }

  async resetInputModes(_id: string): Promise<void> {
    throw new Error('Rex input mode reset unsupported')
  }

  async sendSignal(_id: string, _signal: string): Promise<void> {
    throw new Error('Rex terminal signal unsupported')
  }

  override async shutdown(
    id: string,
    opts: Parameters<IPtyProvider['shutdown']>[1]
  ): Promise<void> {
    if (
      this.spawning.has(id) ||
      opts.keepHistory ||
      opts.expectedOwnerClientInstanceId ||
      (opts.deadlineMs !== undefined && opts.deadlineMs < Date.now() + 5000)
    ) {
      throw new Error('Unsupported Rex termination request')
    }
    const pending = this.pendingExitReclaim(id)
    const attached = this.sessions.get(id)
    if (pending && attached) {
      validateRexShutdown(attached, opts)
      if (await pending) {
        return
      }
    }
    if (this.hasPty(id)) {
      await super.shutdown(id, opts)
      return
    }
    const record = await this.store.read(id, opts.expectedIncarnationId)
    await retireRexSession(this.socketPath, record, this.store, opts.deadlineMs)
  }

  private recoverFresh(ids?: readonly string[]): Promise<void> {
    return recoverRexFreshIntents(this.socketPath, this.store, ids)
  }

  async listProcesses(
    opts?: Parameters<IPtyProvider['listProcesses']>[0]
  ): Promise<PtyProcessInfo[]> {
    await this.recoverFresh(opts?.ptyIds)
    return listRexProcesses(this.socketPath, this.store, opts)
  }

  async probePtyLiveness(id: string): Promise<boolean | null> {
    try {
      await this.store.read(id)
      return (await this.listProcesses({ ptyIds: [id] })).some((record) => record.id === id)
    } catch {
      return null
    }
  }

  acknowledgeDataEvent(_id: string, _charCount: number): void {
    // Native stream is bounded independently; no renderer char-credit protocol.
  }

  onReplay(_callback: Parameters<IPtyProvider['onReplay']>[0]): () => void {
    // Snapshot and ordered tail are returned by attach, not emitted as replay.
    return () => {}
  }

  serialize(ids: string[]): Promise<string> {
    return this.store.serialize(ids)
  }

  revive(state: string): Promise<void> {
    return this.store.revive(state)
  }

  async getDefaultShell(): Promise<string> {
    return userInfo().shell || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  }

  getProfiles(): Promise<{ name: string; path: string }[]> {
    return getRexShellProfiles()
  }
}
