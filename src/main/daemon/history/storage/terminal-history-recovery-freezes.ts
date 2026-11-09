import { randomUUID } from 'node:crypto'
import type { TerminalHistorySessionWriter } from './terminal-history-session-writer'
import { join } from 'node:path'
import { getHistorySessionDirName } from './history-paths'
import {
  markTerminalHistorySessionRecoveryFrozen,
  unmarkTerminalHistorySessionRecoveryFrozen,
  fingerprintTerminalHistorySession,
  type HistoryRecoveryFreeze,
  type ActiveHistoryRecoveryFreeze
} from './terminal-history-recovery-quarantine'

/** Pair manager freezes with process-wide sweep holds so all release paths stay synchronized. */
export class TerminalHistoryRecoveryFreezes {
  private readonly bySessionId = new Map<string, ActiveHistoryRecoveryFreeze>()
  private readonly deadlines = new WeakMap<HistoryRecoveryFreeze, number>()

  constructor(private readonly basePath: string) {}

  get(sessionId: string): ActiveHistoryRecoveryFreeze | undefined {
    return this.bySessionId.get(sessionId)
  }

  has(sessionId: string): boolean {
    return this.bySessionId.has(sessionId)
  }

  hold(sessionId: string, freeze: ActiveHistoryRecoveryFreeze): void {
    this.bySessionId.set(sessionId, freeze)
    // Hold before fingerprinting: an intervening permission sweep would invalidate recovery.
    markTerminalHistorySessionRecoveryFrozen(this.sessionDir(sessionId))
  }

  release(sessionId: string): void {
    if (this.bySessionId.delete(sessionId)) {
      unmarkTerminalHistorySessionRecoveryFrozen(this.sessionDir(sessionId))
    }
  }

  abandon(freeze?: HistoryRecoveryFreeze): void {
    const active = freeze ? this.get(freeze.sessionId) : undefined
    if (active && active.handle === freeze) {
      this.release(active.handle.sessionId)
    }
  }

  releaseAll(): void {
    for (const sessionId of this.bySessionId.keys()) {
      this.release(sessionId)
    }
  }

  deadline(freeze?: HistoryRecoveryFreeze): number | undefined {
    return freeze ? this.deadlines.get(freeze) : undefined
  }

  freeze(
    sessionId: string,
    writers: Map<string, TerminalHistorySessionWriter>,
    deadlineMs: number
  ): HistoryRecoveryFreeze {
    if (this.has(sessionId)) {
      throw new Error('terminal_history_recovery_already_frozen')
    }

    writers.delete(sessionId)
    const handle: HistoryRecoveryFreeze = {
      sessionId,
      token: randomUUID()
    }
    this.deadlines.set(handle, deadlineMs)
    const activeFreeze: ActiveHistoryRecoveryFreeze = { handle }
    this.hold(sessionId, activeFreeze)
    try {
      activeFreeze.fingerprint = fingerprintTerminalHistorySession(this.basePath, sessionId)
      return handle
    } catch (err) {
      if (this.get(sessionId) === activeFreeze) {
        this.release(sessionId)
      }
      throw err
    }
  }

  freezeDrained(sessionId: string, writers: Map<string, TerminalHistorySessionWriter>): () => void {
    if (this.has(sessionId)) {
      throw new Error('terminal_history_recovery_already_frozen')
    }
    const writer = writers.get(sessionId)
    const freeze: ActiveHistoryRecoveryFreeze = { handle: { sessionId, token: randomUUID() } }
    this.hold(sessionId, freeze)
    try {
      writers.delete(sessionId)
    } catch (error) {
      this.release(sessionId)
      throw error
    }
    return () => {
      if (this.get(sessionId) !== freeze) {
        return
      }
      this.release(sessionId)
      if (writer && !writers.has(sessionId)) {
        writers.set(sessionId, writer)
      }
    }
  }

  require(sessionId: string, recoveryFreeze: HistoryRecoveryFreeze): ActiveHistoryRecoveryFreeze {
    const activeFreeze = this.get(sessionId)
    if (
      recoveryFreeze.sessionId !== sessionId ||
      activeFreeze?.handle !== recoveryFreeze ||
      activeFreeze.fingerprint === undefined
    ) {
      throw new Error('terminal_history_recovery_freeze_invalid')
    }
    return activeFreeze
  }

  private sessionDir(sessionId: string): string {
    return join(this.basePath, getHistorySessionDirName(sessionId))
  }
}
