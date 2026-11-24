import { join } from 'node:path'
import { getHistorySessionDirName } from './history-paths'
import {
  markTerminalHistorySessionRecoveryFrozen,
  unmarkTerminalHistorySessionRecoveryFrozen,
  type ActiveHistoryRecoveryFreeze
} from './terminal-history-recovery-quarantine'

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

  releaseAll(): void {
    for (const sessionId of this.bySessionId.keys()) {
      this.release(sessionId)
    }
  }

  private sessionDir(sessionId: string): string {
    return join(this.basePath, getHistorySessionDirName(sessionId))
  }
}
