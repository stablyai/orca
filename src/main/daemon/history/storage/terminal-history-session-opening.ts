import { join } from 'node:path'
import { ensurePrivateDir } from '../../endpoint/publication/daemon-private-file-modes'
import { getHistorySessionDirName } from './history-paths'
import { clearReplayableTerminalHistorySessionFiles } from './terminal-history-session-files'
import {
  fingerprintTerminalHistorySession,
  hasTerminalHistoryRecoveryProtection,
  quarantineTerminalHistorySession,
  type HistoryRecoveryFreeze
} from './terminal-history-recovery-quarantine'
import type { TerminalHistoryRecoveryFreezes } from './terminal-history-recovery-freezes'
import type { TerminalHistoryWriterAdmissions } from './terminal-history-writer-admissions'
import type { HistoryWriterAdmission } from './terminal-history-writer-handoff'
import {
  newTerminalHistoryMeta,
  updateTerminalHistoryMeta,
  writeTerminalHistoryMeta
} from './terminal-history-metadata'
import type { OpenSessionOptions } from './terminal-history-manager-options'

/** The manager state a writer install may touch, always under the caller's captured admission. */
export type TerminalHistorySessionOpening = {
  basePath: string
  freezes: TerminalHistoryRecoveryFreezes
  admissions: TerminalHistoryWriterAdmissions
  disabledSessions: Set<string>
  resizeModel: () => string | null | undefined
  freeze: (sessionId: string) => Promise<HistoryRecoveryFreeze>
  fail: (sessionId: string, error: unknown) => void
}

export async function openTerminalHistorySession(
  ctx: TerminalHistorySessionOpening,
  sessionId: string,
  opts: OpenSessionOptions,
  admission: HistoryWriterAdmission
): Promise<void> {
  let recoveryFreeze = opts.recoveryFreeze
  try {
    ctx.disabledSessions.delete(sessionId)
    const dir = join(ctx.basePath, getHistorySessionDirName(sessionId))
    recoveryFreeze ??= await ctx.freeze(sessionId)
    const activeFreeze = ctx.freezes.require(sessionId, recoveryFreeze)
    // No await from here: a closed admission must not touch a successor's directory.
    if (!admission.current() || !admission.isReady()) {
      throw new Error('terminal_history_admission_closed')
    }
    if (opts.quarantineUnreadableRecovery) {
      quarantineTerminalHistorySession(ctx.basePath, sessionId, activeFreeze.fingerprint ?? null)
    } else if (hasTerminalHistoryRecoveryProtection(ctx.basePath, sessionId)) {
      throw new Error('terminal_history_recovery_protected')
    } else if (
      fingerprintTerminalHistorySession(ctx.basePath, sessionId) !== activeFreeze.fingerprint
    ) {
      throw new Error('terminal_history_recovery_generation_changed')
    }
    ctx.freezes.release(sessionId)
    ensurePrivateDir(dir)
    writeTerminalHistoryMeta(dir, newTerminalHistoryMeta(opts, ctx.resizeModel() ?? null))
    if (!opts.quarantineUnreadableRecovery) {
      clearReplayableTerminalHistorySessionFiles(dir)
    }
    ctx.admissions.install(sessionId, dir, true, admission)
  } catch (err) {
    ctx.freezes.abandon(recoveryFreeze)
    if (admission.current()) {
      ctx.fail(sessionId, err)
    }
  }
}

// Warm reattach must preserve on-disk recovery until the next checkpoint.
export function registerTerminalHistoryWriter(
  ctx: TerminalHistorySessionOpening,
  sessionId: string,
  recoveryFreeze: HistoryRecoveryFreeze | undefined,
  admission: HistoryWriterAdmission
): void {
  // An unsettled predecessor fence leaves history suspended rather than racing its I/O.
  if (!admission.current() || !admission.isReady()) {
    return ctx.freezes.abandon(recoveryFreeze)
  }
  if (ctx.admissions.writers.has(sessionId)) {
    return
  }
  if (hasTerminalHistoryRecoveryProtection(ctx.basePath, sessionId)) {
    ctx.freezes.abandon(recoveryFreeze)
    return void ctx.disabledSessions.add(sessionId)
  }
  if (recoveryFreeze) {
    try {
      const activeFreeze = ctx.freezes.require(sessionId, recoveryFreeze)
      if (fingerprintTerminalHistorySession(ctx.basePath, sessionId) !== activeFreeze.fingerprint) {
        throw new Error('terminal_history_recovery_generation_changed')
      }
      ctx.freezes.release(sessionId)
    } catch (err) {
      ctx.freezes.abandon(recoveryFreeze)
      return ctx.fail(sessionId, err)
    }
  } else if (ctx.freezes.has(sessionId)) {
    return
  }
  const dir = join(ctx.basePath, getHistorySessionDirName(sessionId))
  ctx.admissions.install(sessionId, dir, false, admission)
}

// Wake preserves the sleep checkpoint and clears the clean-end marker for future recovery.
export function reopenTerminalHistorySession(
  ctx: TerminalHistorySessionOpening,
  sessionId: string,
  recoveryFreeze: HistoryRecoveryFreeze | undefined,
  admission: HistoryWriterAdmission
): void {
  if (!admission.current() || !admission.isReady()) {
    return ctx.freezes.abandon(recoveryFreeze)
  }
  ctx.disabledSessions.delete(sessionId)
  registerTerminalHistoryWriter(ctx, sessionId, recoveryFreeze, admission)
  const entry = ctx.admissions.writers.get(sessionId)
  if (!entry || entry.admission !== admission) {
    return
  }
  try {
    entry.writer.assertAdmitted()
    updateTerminalHistoryMeta(entry.writer.dir, { endedAt: null, exitCode: null })
  } catch (err) {
    ctx.fail(sessionId, err)
  }
}
