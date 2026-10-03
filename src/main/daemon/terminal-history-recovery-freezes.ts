import { join } from 'node:path'
import { getHistorySessionDirName } from './history-paths'
import {
  markTerminalHistorySessionRecoveryFrozen,
  unmarkTerminalHistorySessionRecoveryFrozen,
  type ActiveHistoryRecoveryFreeze,
  type HistoryRecoveryFreeze
} from './terminal-history-recovery-quarantine'

/** The recovery freezes one HistoryManager holds, each paired with the process-wide hold that keeps
 *  the backlog permission sweep off a tree whose fingerprint has already been taken. Paired here so
 *  the in-memory freeze and that hold cannot drift apart across the manager's many release paths. */
export class TerminalHistoryRecoveryFreezes {
  private readonly bySessionId = new Map<string, ActiveHistoryRecoveryFreeze>()

  constructor(private readonly basePath: string) {}

  get(sessionId: string): ActiveHistoryRecoveryFreeze | undefined {
    return this.bySessionId.get(sessionId)
  }

  has(sessionId: string): boolean {
    return this.bySessionId.has(sessionId)
  }

  /** Returns the active freeze the handle names, or throws if it isn't the current, fingerprinted one. */
  require(sessionId: string, handle: HistoryRecoveryFreeze): ActiveHistoryRecoveryFreeze {
    const activeFreeze = this.bySessionId.get(sessionId)
    if (
      handle.sessionId !== sessionId ||
      activeFreeze?.handle !== handle ||
      activeFreeze.fingerprint === undefined
    ) {
      throw new Error('terminal_history_recovery_freeze_invalid')
    }
    return activeFreeze
  }

  hold(sessionId: string, freeze: ActiveHistoryRecoveryFreeze): void {
    this.bySessionId.set(sessionId, freeze)
    // Why before the caller's first await: the sweep must see the hold before the freeze reads the
    // fingerprint it later re-checks, or a chmod in between silently disables the session's writer.
    markTerminalHistorySessionRecoveryFrozen(this.sessionDir(sessionId))
  }

  release(sessionId: string): void {
    if (this.bySessionId.delete(sessionId)) {
      unmarkTerminalHistorySessionRecoveryFrozen(this.sessionDir(sessionId))
    }
  }

  /** Why: an outstanding hold would keep the sweep off that tree for the rest of the process. */
  releaseAll(): void {
    for (const sessionId of this.bySessionId.keys()) {
      this.release(sessionId)
    }
  }

  private sessionDir(sessionId: string): string {
    return join(this.basePath, getHistorySessionDirName(sessionId))
  }
}
