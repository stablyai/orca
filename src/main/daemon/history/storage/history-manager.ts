import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { getHistorySessionDirName } from './history-paths'
import type { HistoryRecoveryFreeze } from './terminal-history-recovery-quarantine'
import { TerminalHistoryRecoveryFreezes } from './terminal-history-recovery-freezes'
import {
  removeTerminalHistorySessionTrees,
  schedulePendingSessionTreeRemovals
} from './terminal-history-session-tombstone'
import {
  stampTerminalHistoryResizeModel,
  readTerminalHistoryMetaFromDir,
  updateTerminalHistoryMeta,
  type SessionMeta
} from './terminal-history-metadata'
import type { PendingOutputRecord } from '../../protocol/daemon-rpc-contract'
import type { TerminalSnapshot } from '../../protocol/terminal-snapshot'
import { TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES } from './terminal-history-file-limits'
import { TerminalHistoryMutationTracker } from './terminal-history-mutation-tracker'
import {
  TerminalHistoryWriterAdmissions,
  type CapturedHistoryWriter
} from './terminal-history-writer-admissions'
import {
  openTerminalHistorySession,
  registerTerminalHistoryWriter,
  reopenTerminalHistorySession,
  type TerminalHistorySessionOpening
} from './terminal-history-session-opening'
import type { HistoryWriterAdmission } from './terminal-history-writer-handoff'
import type {
  HistoryCheckpointResult,
  HistoryManagerOptions,
  OpenSessionOptions
} from './terminal-history-manager-options'

export type { CapturedHistoryWriter }

export class HistoryManager {
  private readonly admissions: TerminalHistoryWriterAdmissions
  private readonly writers: Map<string, CapturedHistoryWriter>
  private readonly opening: TerminalHistorySessionOpening
  private disabledSessions = new Set<string>()
  private mutations = new TerminalHistoryMutationTracker()
  private readonly recoveryFreezes: TerminalHistoryRecoveryFreezes
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
    this.admissions = new TerminalHistoryWriterAdmissions(
      basePath,
      this.checkpointMaxBytes,
      (id) => {
        this.disabledSessions.delete(id)
        this.recoveryFreezes.release(id)
        return this.mutations.issued(id)
      }
    )
    this.writers = this.admissions.writers
    this.opening = {
      basePath,
      freezes: this.recoveryFreezes,
      admissions: this.admissions,
      disabledSessions: this.disabledSessions,
      resizeModel: () => this.hostingResizeModel(),
      freeze: (id) => this.freezeForRecovery(id),
      fail: (id, err) => this.handleWriteError(id, err)
    }
    // Resume reclamation left pending by a quit between tombstoning and deletion.
    schedulePendingSessionTreeRemovals(this.basePath)
  }

  /** Capture before any await; see TerminalHistoryWriterAdmissions. */
  admit(sessionId: string): HistoryWriterAdmission {
    return this.admissions.admit(sessionId)
  }

  captureWriter(sessionId: string): CapturedHistoryWriter | undefined {
    return this.writers.get(sessionId)
  }

  async openSession(sessionId: string, opts: OpenSessionOptions): Promise<void> {
    const admission = opts.admission ?? this.admit(sessionId)
    await openTerminalHistorySession(this.opening, sessionId, opts, admission)
  }

  /** Unreadable recovery moves aside before a host-owned origin; this manager installs no writer. */
  quarantineRecovery(
    sessionId: string,
    recoveryFreeze: HistoryRecoveryFreeze,
    admission: HistoryWriterAdmission
  ): void {
    try {
      this.recoveryFreezes.quarantine(sessionId, recoveryFreeze, admission)
    } catch (err) {
      this.onWriteError?.(sessionId, err as Error)
    }
  }

  async freezeForRecovery(sessionId: string): Promise<HistoryRecoveryFreeze> {
    this.writers.delete(sessionId)
    return await this.recoveryFreezes.freeze(sessionId, () => this.mutations.wait(sessionId))
  }

  abandonRecoveryFreeze(freeze?: HistoryRecoveryFreeze): void {
    this.recoveryFreezes.abandon(freeze)
  }

  registerWriter(
    sessionId: string,
    recoveryFreeze?: HistoryRecoveryFreeze,
    admission: HistoryWriterAdmission = this.admit(sessionId)
  ): void {
    registerTerminalHistoryWriter(this.opening, sessionId, recoveryFreeze, admission)
  }

  reopenSession(
    sessionId: string,
    recoveryFreeze?: HistoryRecoveryFreeze,
    admission: HistoryWriterAdmission = this.admit(sessionId)
  ): void {
    reopenTerminalHistorySession(this.opening, sessionId, recoveryFreeze, admission)
  }

  suspendSession(sessionId: string, recoveryFreeze?: HistoryRecoveryFreeze): void {
    // Stop checkpoints from overwriting the only valid recovered scrollback.
    this.writers.delete(sessionId)
    if (recoveryFreeze) {
      this.abandonRecoveryFreeze(recoveryFreeze)
    }
    this.disabledSessions.delete(sessionId)
  }

  /** At log capacity, return needs-checkpoint so the caller can checkpoint and reset the log. */
  appendIncrements(
    sessionId: string,
    seq: number,
    records: PendingOutputRecord[],
    captured: CapturedHistoryWriter | null = this.writers.get(sessionId) ?? null
  ): Promise<'ok' | 'needs-checkpoint'> {
    const append = this.appendIncrementsUntracked(sessionId, seq, records, captured)
    return this.mutations.track(sessionId, append)
  }

  private async appendIncrementsUntracked(
    sessionId: string,
    seq: number,
    records: PendingOutputRecord[],
    captured: CapturedHistoryWriter | null
  ): Promise<'ok' | 'needs-checkpoint'> {
    if (this.disabledSessions.has(sessionId) || records.length === 0) {
      return 'ok'
    }
    if (!captured?.writer.admitted) {
      return 'ok'
    }
    try {
      return await captured.writer.appendIncrements(seq, records)
    } catch (err) {
      if (captured.admission.current()) {
        this.handleWriteError(sessionId, err)
      }
      return 'ok'
    }
  }

  checkpoint(
    sessionId: string,
    snapshot: TerminalSnapshot,
    opts?: { pendingOutputSeq?: number },
    captured: CapturedHistoryWriter | null = this.writers.get(sessionId) ?? null
  ): Promise<HistoryCheckpointResult> {
    const checkpoint = this.checkpointUntracked(sessionId, snapshot, opts, captured)
    return this.mutations.track(sessionId, checkpoint)
  }

  private async checkpointUntracked(
    sessionId: string,
    snapshot: TerminalSnapshot,
    opts: { pendingOutputSeq?: number } | undefined,
    captured: CapturedHistoryWriter | null
  ): Promise<HistoryCheckpointResult> {
    if (this.disabledSessions.has(sessionId)) {
      return 'unavailable'
    }
    if (!captured?.writer.admitted) {
      return 'unavailable'
    }
    const { writer } = captured

    try {
      // Write asynchronously to avoid stalling IPC; per-session serialization protects the fixed temporary path.
      const checkpoint = await writer.checkpoint(snapshot, opts)
      const resizeModel = this.hostingResizeModel()
      // The fresh log is recorded against the daemon hosting the session now; unknown keeps the stamp.
      if (checkpoint.result === 'committed' && resizeModel !== undefined) {
        writer.assertAdmitted()
        stampTerminalHistoryResizeModel(writer.dir, resizeModel)
      }
      if (checkpoint.result === 'retryable') {
        this.onWriteError?.(sessionId, checkpoint.error)
      }
      return checkpoint.result
    } catch (err) {
      if (captured.admission.current()) {
        this.handleWriteError(sessionId, err)
      }
      return 'unavailable'
    }
  }

  async closeSession(
    sessionId: string,
    exitCode: number,
    captured: CapturedHistoryWriter | undefined = this.writers.get(sessionId)
  ): Promise<void> {
    if (!captured || this.writers.get(sessionId) !== captured) {
      return
    }

    this.writers.delete(sessionId)
    // Normal exit must also release IDs disabled by transient write failures.
    this.disabledSessions.delete(sessionId)
    if (!captured.admission.current()) {
      return
    }
    try {
      updateTerminalHistoryMeta(captured.writer.dir, {
        endedAt: new Date().toISOString(),
        exitCode
      })
    } catch (err) {
      // Missing endedAt would falsely authorize cold restore on the next launch.
      this.handleWriteError(sessionId, err)
    }
  }

  /** Uses the close's captured claim; without one, only an unclaimed ID is cleaned up. */
  async removeSession(sessionId: string, captured?: HistoryWriterAdmission): Promise<void> {
    const admission = captured ?? this.admissions.claimForCleanup(sessionId)
    if (!admission?.current()) {
      return
    }
    this.writers.delete(sessionId)
    this.disabledSessions.delete(sessionId)
    this.recoveryFreezes.release(sessionId)
    // Wait on earlier work before tracking this removal, so it never waits on itself.
    const issued = this.mutations.issued(sessionId)
    await this.mutations.track(
      sessionId,
      (async () => {
        await issued
        await admission.ready
        if (admission.current()) {
          // Tombstone first; a fallback in-place deletion stays tracked until it completes.
          await removeTerminalHistorySessionTrees(this.basePath, sessionId)
        }
      })()
    )
    // The history is gone; this claim has nothing left to fence.
    admission.release()
  }

  isSessionDisabled(sessionId: string): boolean {
    return this.disabledSessions.has(sessionId)
  }

  disabledSessionCount(): number {
    return this.disabledSessions.size
  }

  /** Restart-dropped or disposed: release admissions; they stay fenced until their work settles. */
  retire(): void {
    this.admissions.retire()
    this.recoveryFreezes.releaseAll()
  }

  hasWriter(sessionId: string): boolean {
    return this.writers.has(sessionId)
  }

  hasHistory(sessionId: string): boolean {
    return existsSync(join(this.sessionDir(sessionId), 'meta.json'))
  }

  readMeta(sessionId: string): SessionMeta | null {
    return readTerminalHistoryMetaFromDir(this.sessionDir(sessionId))
  }

  async dispose(): Promise<void> {
    // Mark orderly teardown clean so ended sessions cannot trigger cold restore.
    for (const [sessionId, { writer, admission }] of this.writers) {
      if (!admission.current()) {
        continue
      }
      try {
        updateTerminalHistoryMeta(writer.dir, {
          endedAt: new Date().toISOString(),
          exitCode: null
        })
      } catch {
        this.disabledSessions.add(sessionId)
      }
    }
    this.retire()
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
