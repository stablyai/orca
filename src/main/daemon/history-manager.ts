import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { getHistorySessionDirName } from './history-paths'
import { ensurePrivateDir } from './daemon-private-file-modes'
import { clearReplayableTerminalHistorySessionFiles } from './terminal-history-session-files'
import {
  fingerprintTerminalHistorySession,
  hasTerminalHistoryRecoveryProtection,
  quarantineTerminalHistorySession,
  type ActiveHistoryRecoveryFreeze,
  type HistoryRecoveryFreeze
} from './terminal-history-recovery-quarantine'
import { TerminalHistoryRecoveryFreezes } from './terminal-history-recovery-freezes'
import {
  removeTerminalHistorySessionTrees,
  schedulePendingSessionTreeRemovals
} from './terminal-history-session-tombstone'
import { TerminalHistorySessionWriter } from './terminal-history-session-writer'
import {
  readTerminalHistoryMetaFromDir,
  updateTerminalHistoryMeta,
  writeTerminalHistoryMeta,
  type SessionMeta
} from './terminal-history-metadata'
import type { PendingOutputRecord, TerminalSnapshot } from './types'
import { TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES } from './terminal-history-file-limits'
import { TerminalHistoryMutationTracker } from './terminal-history-mutation-tracker'
import type {
  HistoryCheckpointResult,
  HistoryManagerOptions,
  OpenSessionOptions
} from './terminal-history-manager-options'

export type { SessionMeta } from './terminal-history-metadata'
export type { HistoryRecoveryFreeze } from './terminal-history-recovery-quarantine'
export type * from './terminal-history-manager-options'

export class HistoryManager {
  private writers = new Map<string, TerminalHistorySessionWriter>()
  private disabledSessions = new Set<string>()
  private mutations = new TerminalHistoryMutationTracker()
  private readonly recoveryFreezes: TerminalHistoryRecoveryFreezes
  private onWriteError?: (sessionId: string, error: Error) => void
  private checkpointMaxBytes: number

  constructor(
    private readonly basePath: string,
    opts?: HistoryManagerOptions
  ) {
    this.onWriteError = opts?.onWriteError
    this.checkpointMaxBytes = opts?.checkpointMaxBytes ?? TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES
    this.recoveryFreezes = new TerminalHistoryRecoveryFreezes(basePath)
    // Resume reclamation left pending by a quit between tombstoning and deletion.
    schedulePendingSessionTreeRemovals(this.basePath)
  }

  async openSession(sessionId: string, opts: OpenSessionOptions): Promise<void> {
    let recoveryFreeze = opts.recoveryFreeze
    try {
      this.disabledSessions.delete(sessionId)
      const dir = this.sessionDir(sessionId)
      recoveryFreeze ??= await this.freezeForRecovery(sessionId)
      const activeFreeze = this.requireRecoveryFreeze(sessionId, recoveryFreeze)

      if (opts.quarantineUnreadableRecovery) {
        quarantineTerminalHistorySession(this.basePath, sessionId, activeFreeze.fingerprint ?? null)
      } else if (hasTerminalHistoryRecoveryProtection(this.basePath, sessionId)) {
        throw new Error('terminal_history_recovery_protected')
      } else if (
        fingerprintTerminalHistorySession(this.basePath, sessionId) !== activeFreeze.fingerprint
      ) {
        throw new Error('terminal_history_recovery_generation_changed')
      }
      this.recoveryFreezes.release(sessionId)
      ensurePrivateDir(dir)

      const meta: SessionMeta = {
        cwd: opts.cwd,
        cols: opts.cols,
        rows: opts.rows,
        startedAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null
      }
      writeTerminalHistoryMeta(dir, meta)

      if (!opts.quarantineUnreadableRecovery) {
        clearReplayableTerminalHistorySessionFiles(dir)
      }

      this.writers.set(
        sessionId,
        new TerminalHistorySessionWriter(dir, true, this.checkpointMaxBytes)
      )
    } catch (err) {
      if (recoveryFreeze) {
        this.abandonRecoveryFreeze(recoveryFreeze)
      }
      this.handleWriteError(sessionId, err)
    }
  }

  async freezeForRecovery(sessionId: string): Promise<HistoryRecoveryFreeze> {
    if (this.recoveryFreezes.has(sessionId)) {
      throw new Error('terminal_history_recovery_already_frozen')
    }

    this.writers.delete(sessionId)
    const handle: HistoryRecoveryFreeze = {
      sessionId,
      token: randomUUID()
    }
    const activeFreeze: ActiveHistoryRecoveryFreeze = { handle }
    this.recoveryFreezes.hold(sessionId, activeFreeze)
    try {
      await this.mutations.wait(sessionId)
      activeFreeze.fingerprint = fingerprintTerminalHistorySession(this.basePath, sessionId)
      return handle
    } catch (err) {
      if (this.recoveryFreezes.get(sessionId) === activeFreeze) {
        this.recoveryFreezes.release(sessionId)
      }
      throw err
    }
  }

  abandonRecoveryFreeze(freeze?: HistoryRecoveryFreeze): void {
    const activeFreeze = freeze ? this.recoveryFreezes.get(freeze.sessionId) : undefined
    if (activeFreeze && activeFreeze.handle === freeze) {
      this.recoveryFreezes.release(activeFreeze.handle.sessionId)
    }
  }

  // Warm reattach must preserve on-disk recovery until the next checkpoint.
  registerWriter(sessionId: string, recoveryFreeze?: HistoryRecoveryFreeze): void {
    if (this.writers.has(sessionId)) {
      return
    }
    if (hasTerminalHistoryRecoveryProtection(this.basePath, sessionId)) {
      this.abandonRecoveryFreeze(recoveryFreeze)
      return void this.disabledSessions.add(sessionId)
    }
    if (recoveryFreeze) {
      try {
        const activeFreeze = this.requireRecoveryFreeze(sessionId, recoveryFreeze)
        if (
          fingerprintTerminalHistorySession(this.basePath, sessionId) !== activeFreeze.fingerprint
        ) {
          throw new Error('terminal_history_recovery_generation_changed')
        }
        this.recoveryFreezes.release(sessionId)
      } catch (err) {
        this.abandonRecoveryFreeze(recoveryFreeze)
        this.handleWriteError(sessionId, err)
        return
      }
    } else if (this.recoveryFreezes.has(sessionId)) {
      return
    }
    const dir = this.sessionDir(sessionId)
    this.writers.set(
      sessionId,
      new TerminalHistorySessionWriter(dir, false, this.checkpointMaxBytes)
    )
  }

  // Wake preserves the sleep checkpoint and clears the clean-end marker for future recovery.
  reopenSession(sessionId: string, recoveryFreeze?: HistoryRecoveryFreeze): void {
    this.disabledSessions.delete(sessionId)
    this.registerWriter(sessionId, recoveryFreeze)
    const writer = this.writers.get(sessionId)
    if (!writer) {
      return
    }
    try {
      updateTerminalHistoryMeta(writer.dir, { endedAt: null, exitCode: null })
    } catch (err) {
      this.handleWriteError(sessionId, err)
    }
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
    records: PendingOutputRecord[]
  ): Promise<'ok' | 'needs-checkpoint'> {
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
    opts?: { pendingOutputSeq?: number }
  ): Promise<HistoryCheckpointResult> {
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
    const writer = this.writers.get(sessionId)
    if (!writer) {
      return
    }

    this.writers.delete(sessionId)
    // Normal exit must also release IDs disabled by transient write failures.
    this.disabledSessions.delete(sessionId)
    try {
      updateTerminalHistoryMeta(writer.dir, { endedAt: new Date().toISOString(), exitCode })
    } catch (err) {
      // Missing endedAt would falsely authorize cold restore on the next launch.
      this.handleWriteError(sessionId, err)
    }
  }

  async removeSession(sessionId: string): Promise<void> {
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

  disabledSessionCount(): number {
    return this.disabledSessions.size
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
    for (const [sessionId, writer] of this.writers) {
      try {
        updateTerminalHistoryMeta(writer.dir, {
          endedAt: new Date().toISOString(),
          exitCode: null
        })
      } catch {
        this.disabledSessions.add(sessionId)
      }
    }
    this.writers.clear()
    this.recoveryFreezes.releaseAll()
  }

  // Disable best-effort history on error instead of rejecting fire-and-forget callers.
  private handleWriteError(sessionId: string, err: unknown): void {
    this.disabledSessions.add(sessionId)
    this.onWriteError?.(sessionId, err as Error)
  }

  private sessionDir(sessionId: string): string {
    return join(this.basePath, getHistorySessionDirName(sessionId))
  }

  private requireRecoveryFreeze(
    sessionId: string,
    recoveryFreeze: HistoryRecoveryFreeze
  ): ActiveHistoryRecoveryFreeze {
    const activeFreeze = this.recoveryFreezes.get(sessionId)
    if (
      recoveryFreeze.sessionId !== sessionId ||
      activeFreeze?.handle !== recoveryFreeze ||
      activeFreeze.fingerprint === undefined
    ) {
      throw new Error('terminal_history_recovery_freeze_invalid')
    }
    return activeFreeze
  }
}
