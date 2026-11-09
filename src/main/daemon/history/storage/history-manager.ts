import {
  releaseTerminalHistoryManager,
  registerTerminalHistoryManager,
  closeTerminalHistoryWriter,
  settleCapturedTerminalHistoryWriter,
  registerRecoveredTerminalHistoryWriter,
  reopenTerminalHistoryWriter
} from './terminal-history-manager-release'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { getHistorySessionDirName } from './history-paths'
import type { HistoryRecoveryFreeze } from './terminal-history-recovery-quarantine'
import { openTerminalHistoryWriter } from './terminal-history-session-opening'
import { TerminalHistoryRecoveryFreezes } from './terminal-history-recovery-freezes'
import {
  removeTerminalHistorySessionTrees,
  schedulePendingSessionTreeRemovals
} from './terminal-history-session-tombstone'
import type { TerminalHistorySessionWriter } from './terminal-history-session-writer'
import {
  stampTerminalHistoryResizeModel,
  readTerminalHistoryMetaFromDir,
  type SessionMeta
} from './terminal-history-metadata'
import type { PendingOutputRecord } from '../../protocol/daemon-rpc-contract'
import type { TerminalSnapshot } from '../../protocol/terminal-snapshot'
import { TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES } from './terminal-history-file-limits'
import { TerminalHistoryMutationTracker } from './terminal-history-mutation-tracker'
import { terminalHistoryRoot, type TerminalHistoryCheckpointReceipt } from './terminal-history-root'
import type {
  HistoryCheckpointResult,
  HistoryManagerOptions,
  OpenSessionOptions
} from './terminal-history-manager-options'

export class HistoryManager {
  private writers = new Map<string, TerminalHistorySessionWriter>()
  private disabledSessions = new Set<string>()
  private mutations = new TerminalHistoryMutationTracker()
  private lifecycleMutations = new TerminalHistoryMutationTracker()
  readonly identityRoot: ReturnType<typeof terminalHistoryRoot>
  private readonly identity: ReturnType<typeof registerTerminalHistoryManager>
  private readonly recoveryFreezes: TerminalHistoryRecoveryFreezes
  private identityRelease: Promise<void> | undefined
  private onWriteError?: (sessionId: string, error: Error) => void
  private checkpointMaxBytes: number
  /** The hosting daemon's reported model, which its live output (and so a rebuild) follows. */
  readonly hostingResizeModel: () => string | null | undefined

  constructor(
    private readonly basePath: string,
    opts?: HistoryManagerOptions
  ) {
    this.onWriteError = opts?.onWriteError
    this.checkpointMaxBytes = opts?.checkpointMaxBytes ?? TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES
    this.hostingResizeModel = opts?.resizeModel ?? (() => null)
    this.recoveryFreezes = new TerminalHistoryRecoveryFreezes(basePath)
    this.identityRoot = terminalHistoryRoot(basePath)
    this.identity = registerTerminalHistoryManager(this.identityRoot, {
      writer: (id) => this.writers.get(id) ?? this.recoveryFreezes.get(id),
      drain: (id) => Promise.all([this.lifecycleMutations.wait(id), this.mutations.wait(id)]),
      freeze: (id) => this.recoveryFreezes.freezeDrained(id, this.writers)
    })
    // Resume reclamation left pending by a quit between tombstoning and deletion.
    schedulePendingSessionTreeRemovals(this.basePath)
  }

  private prepareWriter = (sessionId: string, recoveryFreeze?: HistoryRecoveryFreeze) => ({
    deadlineMs: this.recoveryFreezes.deadline(recoveryFreeze),
    prepare: () => {
      const work = [
        this.identity.drainRetired(sessionId),
        this.lifecycleMutations.waitIfPending(sessionId),
        this.mutations.waitIfPending(sessionId)
      ].filter((pending) => pending !== undefined)
      return work.length ? Promise.all(work) : undefined
    },
    abandon: () => this.abandonRecoveryFreeze(recoveryFreeze)
  })

  async openSession(sessionId: string, opts: OpenSessionOptions): Promise<void> {
    this.identityRoot?.willMutate(sessionId)
    await this.identity.acquire(
      sessionId,
      this.prepareWriter(sessionId, opts.recoveryFreeze),
      (deadlineMs) => {
        this.disabledSessions.delete(sessionId)
        openTerminalHistoryWriter(
          this.basePath,
          sessionId,
          opts,
          deadlineMs,
          this.writers,
          this.recoveryFreezes,
          this.checkpointMaxBytes,
          this.hostingResizeModel() ?? null,
          (error) => this.handleWriteError(sessionId, error)
        )
      }
    )
  }

  async freezeForRecovery(sessionId: string): Promise<HistoryRecoveryFreeze> {
    this.identityRoot?.willMutate(sessionId)
    const result = await this.identity.acquire(
      sessionId,
      this.prepareWriter(sessionId),
      (deadlineMs) => this.recoveryFreezes.freeze(sessionId, this.writers, deadlineMs)
    )
    if (!result.entered) {
      throw new Error('terminal_history_writer_admission_unavailable')
    }
    return result.value
  }

  retireIdentity = (tail: (id: string) => Promise<unknown>): void => this.identity.retire(tail)

  abandonRecoveryFreeze(freeze?: HistoryRecoveryFreeze): void {
    this.recoveryFreezes.abandon(freeze)
  }

  registerWriter(sessionId: string, recoveryFreeze?: HistoryRecoveryFreeze): Promise<void> {
    return this.registerRecoveredWriter(sessionId, recoveryFreeze, false)
  }

  // Wake preserves the sleep checkpoint and clears the clean-end marker for future recovery.
  reopenSession(sessionId: string, recoveryFreeze?: HistoryRecoveryFreeze): Promise<void> {
    return this.registerRecoveredWriter(sessionId, recoveryFreeze, true)
  }

  private async registerRecoveredWriter(
    sessionId: string,
    recoveryFreeze: HistoryRecoveryFreeze | undefined,
    reopen: boolean
  ): Promise<void> {
    this.identityRoot?.willMutate(sessionId)
    const operation = (): void => {
      registerRecoveredTerminalHistoryWriter(
        this.basePath,
        sessionId,
        recoveryFreeze,
        this.writers,
        this.recoveryFreezes,
        this.checkpointMaxBytes,
        () => this.disabledSessions.add(sessionId),
        (error) => this.handleWriteError(sessionId, error)
      )
      if (this.writers.has(sessionId)) {
        this.disabledSessions.delete(sessionId)
        if (reopen) {
          reopenTerminalHistoryWriter(sessionId, this.writers, (error) =>
            this.handleWriteError(sessionId, error)
          )
        }
      }
    }
    if (this.writers.has(sessionId) && this.identity.admissionsOpen()) {
      operation()
      return
    }
    await this.identity.acquire(sessionId, this.prepareWriter(sessionId, recoveryFreeze), operation)
  }

  captureWriter = (sessionId: string): TerminalHistorySessionWriter | undefined =>
    this.writers.get(sessionId)

  drainCapturedWriter = (id: string): Promise<unknown> =>
    Promise.all([this.lifecycleMutations.wait(id), this.mutations.wait(id)])

  settleCapturedWriter(
    sessionId: string,
    writer: TerminalHistorySessionWriter,
    removeHistory: boolean
  ): void {
    if (removeHistory) {
      this.identityRoot?.willMutate(sessionId)
    }
    settleCapturedTerminalHistoryWriter(
      sessionId,
      writer,
      removeHistory,
      this.writers,
      this.disabledSessions,
      this.basePath
    )
  }

  suspendSession(sessionId: string, recoveryFreeze?: HistoryRecoveryFreeze): void {
    this.identityRoot?.willMutate(sessionId)
    // Stop checkpoints from overwriting the only valid recovered scrollback.
    this.writers.delete(sessionId)
    if (recoveryFreeze) {
      this.abandonRecoveryFreeze(recoveryFreeze)
    }
    this.disabledSessions.delete(sessionId)
  }

  appendIncrements(
    sessionId: string,
    seq: number,
    records: PendingOutputRecord[],
    receipt?: TerminalHistoryCheckpointReceipt
  ): Promise<'ok' | 'needs-checkpoint'> {
    this.identityRoot?.willMutate(sessionId, receipt)
    return this.mutations.track(sessionId, this.appendIncrementsUntracked(sessionId, seq, records))
  }

  private async appendIncrementsUntracked(
    sessionId: string,
    seq: number,
    records: PendingOutputRecord[]
  ): Promise<'ok' | 'needs-checkpoint'> {
    if (this.disabledSessions.has(sessionId) || records.length === 0) {
      return 'ok'
    }
    const writer = this.writers.get(sessionId)
    if (!writer) {
      return 'ok'
    }
    try {
      return await writer.appendIncrements(seq, records)
    } catch (err) {
      this.handleWriteError(sessionId, err)
      return 'ok'
    }
  }

  checkpoint(
    sessionId: string,
    snapshot: TerminalSnapshot,
    opts?: { pendingOutputSeq?: number },
    receipt?: TerminalHistoryCheckpointReceipt
  ): Promise<HistoryCheckpointResult> {
    this.identityRoot?.willMutate(sessionId, receipt)
    return this.mutations.track(sessionId, this.checkpointUntracked(sessionId, snapshot, opts))
  }

  private async checkpointUntracked(
    sessionId: string,
    snapshot: TerminalSnapshot,
    opts?: { pendingOutputSeq?: number }
  ): Promise<HistoryCheckpointResult> {
    if (this.disabledSessions.has(sessionId)) {
      return 'unavailable'
    }
    const writer = this.writers.get(sessionId)
    if (!writer) {
      return 'unavailable'
    }

    try {
      // Write asynchronously to avoid stalling IPC; per-session serialization protects the fixed temporary path.
      const checkpoint = await writer.checkpoint(snapshot, opts)
      const resizeModel = this.hostingResizeModel()
      // The fresh log is recorded against the daemon hosting the session now; unknown keeps the stamp.
      if (checkpoint.result === 'committed' && resizeModel !== undefined) {
        stampTerminalHistoryResizeModel(writer.dir, resizeModel)
      }
      if (checkpoint.result === 'retryable') {
        this.onWriteError?.(sessionId, checkpoint.error)
      }
      return checkpoint.result
    } catch (err) {
      this.handleWriteError(sessionId, err)
      return 'unavailable'
    }
  }

  async closeSession(sessionId: string, exitCode: number): Promise<void> {
    this.identityRoot?.willMutate(sessionId)
    closeTerminalHistoryWriter(sessionId, exitCode, this.writers, this.disabledSessions, (error) =>
      this.handleWriteError(sessionId, error)
    )
  }

  removeSession(sessionId: string): Promise<void> {
    this.identityRoot?.willMutate(sessionId)
    return this.lifecycleMutations.track(sessionId, this.removeSessionUntracked(sessionId))
  }

  private async removeSessionUntracked(sessionId: string): Promise<void> {
    this.writers.delete(sessionId)
    this.disabledSessions.delete(sessionId)
    this.recoveryFreezes.release(sessionId)
    await this.mutations.wait(sessionId)
    // Tombstone first so worktree deletion need not await reclamation of large history trees.
    await removeTerminalHistorySessionTrees(this.basePath, sessionId)
  }

  isSessionDisabled(sessionId: string): boolean {
    return this.disabledSessions.has(sessionId)
  }

  disabledSessionCount = (): number => this.disabledSessions.size

  hasWriter(sessionId: string): boolean {
    return this.writers.has(sessionId)
  }

  hasHistory(sessionId: string): boolean {
    return existsSync(join(this.sessionDir(sessionId), 'meta.json'))
  }

  readMeta(sessionId: string): SessionMeta | null {
    return readTerminalHistoryMetaFromDir(this.sessionDir(sessionId))
  }

  dispose = (): Promise<void> => this.releaseIdentity('clean')

  releaseIdentity(disposition: 'clean' | 'detach'): Promise<void> {
    this.identityRoot?.cancelMigrations()
    this.identity.closeAdmissions()
    this.identityRelease ??= this.identity
      .drainAcquisitions()
      .then(() =>
        releaseTerminalHistoryManager(
          disposition,
          this.writers,
          this.disabledSessions,
          this.lifecycleMutations,
          this.mutations,
          this.recoveryFreezes,
          this.identity.release
        )
      )
    return this.identityRelease
  }

  // Disable best-effort history on error instead of rejecting fire-and-forget callers.
  private handleWriteError(sessionId: string, err: unknown): void {
    this.disabledSessions.add(sessionId)
    this.onWriteError?.(sessionId, err as Error)
  }

  private sessionDir(sessionId: string): string {
    return join(this.basePath, getHistorySessionDirName(sessionId))
  }
}
