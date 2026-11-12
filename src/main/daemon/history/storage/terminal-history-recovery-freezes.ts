import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getHistorySessionDirName } from './history-paths'
import {
  fingerprintTerminalHistorySession,
  markTerminalHistorySessionRecoveryFrozen,
  quarantineTerminalHistorySession,
  unmarkTerminalHistorySessionRecoveryFrozen,
  type ActiveHistoryRecoveryFreeze,
  type HistoryRecoveryFreeze
} from './terminal-history-recovery-quarantine'
import type { HistoryWriterAdmission } from './terminal-history-writer-handoff'

/** Pair manager freezes with process-wide sweep holds so all release paths stay synchronized. */
export class TerminalHistoryRecoveryFreezes {
  private readonly bySessionId = new Map<string, ActiveHistoryRecoveryFreeze>()

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

  /** Fingerprint only after this manager's own issued writes settle. */
  async freeze(sessionId: string, settled: () => Promise<void>): Promise<HistoryRecoveryFreeze> {
    if (this.has(sessionId)) {
      throw new Error('terminal_history_recovery_already_frozen')
    }
    const handle: HistoryRecoveryFreeze = { sessionId, token: randomUUID() }
    const activeFreeze: ActiveHistoryRecoveryFreeze = { handle }
    this.hold(sessionId, activeFreeze)
    try {
      await settled()
      activeFreeze.fingerprint = fingerprintTerminalHistorySession(this.basePath, sessionId)
      return handle
    } catch (err) {
      if (this.get(sessionId) === activeFreeze) {
        this.release(sessionId)
      }
      throw err
    }
  }

  /** Releases only this exact handle; a successor's freeze for the ID stays. */
  abandon(freeze?: HistoryRecoveryFreeze): void {
    if (freeze && this.get(freeze.sessionId)?.handle === freeze) {
      this.release(freeze.sessionId)
    }
  }

  require(sessionId: string, freeze: HistoryRecoveryFreeze): ActiveHistoryRecoveryFreeze {
    const activeFreeze = this.get(sessionId)
    if (
      freeze.sessionId !== sessionId ||
      activeFreeze?.handle !== freeze ||
      activeFreeze.fingerprint === undefined
    ) {
      throw new Error('terminal_history_recovery_freeze_invalid')
    }
    return activeFreeze
  }

  /** Moves unreadable recovery aside intact under a still-current admission, then releases it. */
  quarantine(
    sessionId: string,
    freeze: HistoryRecoveryFreeze,
    admission: HistoryWriterAdmission
  ): void {
    try {
      const activeFreeze = this.require(sessionId, freeze)
      if (admission.current()) {
        quarantineTerminalHistorySession(this.basePath, sessionId, activeFreeze.fingerprint ?? null)
      }
    } finally {
      this.abandon(freeze)
    }
  }

  releaseAll(): void {
    for (const sessionId of this.bySessionId.keys()) {
      this.release(sessionId)
    }
  }

  private sessionDir(sessionId: string): string {
    return join(this.basePath, getHistorySessionDirName(sessionId))
  }
}
