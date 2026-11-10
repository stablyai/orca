import { join } from 'node:path'
import { ensurePrivateDir } from '../../endpoint/publication/daemon-private-file-modes'
import { getHistorySessionDirName } from './history-paths'
import { clearReplayableTerminalHistorySessionFiles } from './terminal-history-session-files'
import {
  fingerprintTerminalHistorySession,
  hasTerminalHistoryRecoveryProtection,
  quarantineTerminalHistorySession
} from './terminal-history-recovery-quarantine'
import type { TerminalHistoryRecoveryFreezes } from './terminal-history-recovery-freezes'
import type { OpenSessionOptions } from './terminal-history-manager-options'
import { newTerminalHistoryMeta, writeTerminalHistoryMeta } from './terminal-history-metadata'
import { TerminalHistorySessionWriter } from './terminal-history-session-writer'

export function openTerminalHistoryWriter(
  basePath: string,
  sessionId: string,
  opts: OpenSessionOptions,
  deadlineMs: number,
  writers: Map<string, TerminalHistorySessionWriter>,
  freezes: TerminalHistoryRecoveryFreezes,
  maxBytes: number,
  resizeModel: string | null,
  onError: (error: unknown) => void
): void {
  let recoveryFreeze = opts.recoveryFreeze
  try {
    const dir = join(basePath, getHistorySessionDirName(sessionId))
    recoveryFreeze ??= freezes.freeze(sessionId, writers, deadlineMs)
    const activeFreeze = freezes.require(sessionId, recoveryFreeze)
    if (opts.quarantineUnreadableRecovery) {
      quarantineTerminalHistorySession(basePath, sessionId, activeFreeze.fingerprint ?? null)
    } else if (hasTerminalHistoryRecoveryProtection(basePath, sessionId)) {
      throw new Error('terminal_history_recovery_protected')
    } else if (
      fingerprintTerminalHistorySession(basePath, sessionId) !== activeFreeze.fingerprint
    ) {
      throw new Error('terminal_history_recovery_generation_changed')
    }
    freezes.release(sessionId)
    ensurePrivateDir(dir)
    writeTerminalHistoryMeta(dir, newTerminalHistoryMeta(opts, resizeModel))
    if (!opts.quarantineUnreadableRecovery) {
      clearReplayableTerminalHistorySessionFiles(dir)
    }
    writers.set(sessionId, new TerminalHistorySessionWriter(dir, true, maxBytes))
  } catch (error) {
    freezes.abandon(recoveryFreeze)
    onError(error)
  }
}
