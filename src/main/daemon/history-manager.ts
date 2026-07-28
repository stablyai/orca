import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, rmSync, unlinkSync } from 'node:fs'
import { getHistorySessionDirName } from './history-paths'
import {
  fingerprintTerminalHistorySession,
  hasTerminalHistoryRecoveryProtection,
  quarantineTerminalHistorySession,
  removeTerminalHistoryQuarantines,
  type ActiveHistoryRecoveryFreeze,
  type HistoryRecoveryFreeze
} from './terminal-history-recovery-quarantine'
import { TerminalHistorySessionWriter } from './terminal-history-session-writer'
import {
  readTerminalHistoryMetaFromDir,
  updateTerminalHistoryMeta,
  type SessionMeta
} from './terminal-history-metadata'
import type { PendingOutputRecord, TerminalSnapshot } from './types'
import type { HistoryManagerOptions, OpenSessionOptions } from './terminal-history-manager-options'

export type { SessionMeta } from './terminal-history-metadata'
export type { HistoryRecoveryFreeze } from './terminal-history-recovery-quarantine'
export type { HistoryManagerOptions, OpenSessionOptions } from './terminal-history-manager-options'

export class HistoryManager {
  private basePath: string
  private writers = new Map<string, TerminalHistorySessionWriter>()
  private disabledSessions = new Set<string>()
  private pendingSessionMutations = new Map<string, Set<Promise<unknown>>>()
  private recoveryFreezes = new Map<string, ActiveHistoryRecoveryFreeze>()
  private onWriteError?: (sessionId: string, error: Error) => void

  constructor(basePath: string, opts?: HistoryManagerOptions) {
    this.basePath = basePath
    this.onWriteError = opts?.onWriteError
  }

  async openSession(sessionId: string, opts: OpenSessionOptions): Promise<void> {
    let recoveryFreeze = opts.recoveryFreeze
    try {
      this.disabledSessions.delete(sessionId)
      const dir = join(this.basePath, getHistorySessionDirName(sessionId))
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
      this.recoveryFreezes.delete(sessionId)
      mkdirSync(dir, { recursive: true })

      const meta: SessionMeta = {
        cwd: opts.cwd,
        cols: opts.cols,
        rows: opts.rows,
        startedAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null
      }
      writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))

      if (!opts.quarantineUnreadableRecovery) {
        // Why: a crash before the first checkpoint must not replay a cleanly ended prior session.
        for (const staleFile of [
          join(dir, 'checkpoint.json'),
          join(dir, 'scrollback.bin'),
          join(dir, 'output.log')
        ]) {
          try {
            unlinkSync(staleFile)
          } catch {
            // ENOENT is expected for new sessions
          }
        }
      }

      this.writers.set(sessionId, new TerminalHistorySessionWriter(dir, true))
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
    this.recoveryFreezes.set(sessionId, activeFreeze)
    try {
      await this.waitForSessionMutations(sessionId)
      activeFreeze.fingerprint = fingerprintTerminalHistorySession(this.basePath, sessionId)
      return handle
    } catch (err) {
      if (this.recoveryFreezes.get(sessionId) === activeFreeze) {
        this.recoveryFreezes.delete(sessionId)
      }
      throw err
    }
  }

  abandonRecoveryFreeze(freeze?: HistoryRecoveryFreeze): void {
    const activeFreeze = freeze ? this.recoveryFreezes.get(freeze.sessionId) : undefined
    if (activeFreeze && activeFreeze.handle === freeze) {
      this.recoveryFreezes.delete(activeFreeze.handle.sessionId)
    }
  }

  // Why: warm reattach has no in-memory writers; re-register without touching meta.json or checkpoint.json (only recovery data until the next tick).
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
        this.recoveryFreezes.delete(sessionId)
      } catch (err) {
        this.abandonRecoveryFreeze(recoveryFreeze)
        this.handleWriteError(sessionId, err)
        return
      }
    } else if (this.recoveryFreezes.has(sessionId)) {
      return
    }
    const dir = join(this.basePath, getHistorySessionDirName(sessionId))
    this.writers.set(sessionId, new TerminalHistorySessionWriter(dir, false))
  }

  // Why: wake re-spawns a sleep-killed session; re-register without deleting checkpoint.json, clear endedAt so it can cold-restore again.
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
    // Why: leaving the writer active would let the next checkpoint overwrite the only good recovered-scrollback copy.
    this.writers.delete(sessionId)
    if (recoveryFreeze) {
      this.abandonRecoveryFreeze(recoveryFreeze)
    }
    this.disabledSessions.delete(sessionId)
  }

  /** Appends one batch to the incremental log; returns 'needs-checkpoint' at capacity, signalling the caller to checkpoint() (which resets the log). */
  appendIncrements(
    sessionId: string,
    seq: number,
    records: PendingOutputRecord[]
  ): Promise<'ok' | 'needs-checkpoint'> {
    return this.trackSessionMutation(
      sessionId,
      this.appendIncrementsUntracked(sessionId, seq, records)
    )
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

  // Full checkpoints are rare (clean disconnect, pending-buffer overflow, log cap); the 5s tick appends increments instead.
  checkpoint(sessionId: string, snapshot: TerminalSnapshot): Promise<void> {
    return this.trackSessionMutation(sessionId, this.checkpointUntracked(sessionId, snapshot))
  }

  private async checkpointUntracked(sessionId: string, snapshot: TerminalSnapshot): Promise<void> {
    if (this.disabledSessions.has(sessionId)) {
      return
    }
    const writer = this.writers.get(sessionId)
    if (!writer) {
      return
    }

    try {
      // Why: tmp+rename is atomic (corrupt checkpoint > stale); async so a sync ~MB write can't stall IPC (worse under Windows AV).
      // The adapter's checkpointInFlight guard serializes checkpoints, so concurrent async writes can't collide on the fixed .tmp path.
      await writer.checkpoint(snapshot)
    } catch (err) {
      this.handleWriteError(sessionId, err)
    }
  }

  async closeSession(sessionId: string, exitCode: number): Promise<void> {
    const writer = this.writers.get(sessionId)
    if (!writer) {
      return
    }

    this.writers.delete(sessionId)
    // Why: session is dead; without this a transient-error-poisoned id leaks forever (sessionIds never reused).
    this.disabledSessions.delete(sessionId)
    try {
      updateTerminalHistoryMeta(writer.dir, { endedAt: new Date().toISOString(), exitCode })
    } catch (err) {
      // Why: an unwritten endedAt looks like an unclean shutdown → false cold restore next launch.
      this.handleWriteError(sessionId, err)
    }
  }

  async removeSession(sessionId: string): Promise<void> {
    this.writers.delete(sessionId)
    this.disabledSessions.delete(sessionId)
    const activeFreeze = this.recoveryFreezes.get(sessionId)
    if (activeFreeze) {
      this.recoveryFreezes.delete(sessionId)
    }
    await this.waitForSessionMutations(sessionId)
    rmSync(join(this.basePath, getHistorySessionDirName(sessionId)), {
      recursive: true,
      force: true
    })
    removeTerminalHistoryQuarantines(this.basePath, sessionId)
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
    return existsSync(join(this.basePath, getHistorySessionDirName(sessionId), 'meta.json'))
  }

  readMeta(sessionId: string): SessionMeta | null {
    const dir = join(this.basePath, getHistorySessionDirName(sessionId))
    return readTerminalHistoryMetaFromDir(dir)
  }

  async dispose(): Promise<void> {
    // Why: mark open sessions cleanly ended so they don't trigger false cold-restores next launch.
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
  }

  // Why: history is best-effort; callers fire-and-forget so a throw would be an unhandled rejection — disable instead.
  private handleWriteError(sessionId: string, err: unknown): void {
    this.disabledSessions.add(sessionId)
    this.onWriteError?.(sessionId, err as Error)
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

  private trackSessionMutation<T>(sessionId: string, operation: Promise<T>): Promise<T> {
    const mutations = this.pendingSessionMutations.get(sessionId) ?? new Set<Promise<unknown>>()
    mutations.add(operation)
    this.pendingSessionMutations.set(sessionId, mutations)
    void operation.then(
      () => this.finishSessionMutation(sessionId, operation),
      () => this.finishSessionMutation(sessionId, operation)
    )
    return operation
  }

  private finishSessionMutation(sessionId: string, operation: Promise<unknown>): void {
    const mutations = this.pendingSessionMutations.get(sessionId)
    mutations?.delete(operation)
    if (mutations?.size === 0) {
      this.pendingSessionMutations.delete(sessionId)
    }
  }

  private async waitForSessionMutations(sessionId: string): Promise<void> {
    while (this.pendingSessionMutations.has(sessionId)) {
      await Promise.allSettled(this.pendingSessionMutations.get(sessionId)!)
    }
  }
}
