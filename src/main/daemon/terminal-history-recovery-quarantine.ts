import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ensurePrivateDir, PRIVATE_FILE_MODE } from './daemon-private-file-modes'
import { getHistorySessionDirName } from './history-paths'

const QUARANTINE_DIR_NAME = '.recovery-quarantine'
const RECOVERY_PROTECTION_MARKER = '.unreadable-recovery'

export type TerminalHistoryDirectoryFingerprint = string | null

export type HistoryRecoveryFreeze = {
  readonly sessionId: string
  readonly token: string
}

export type ActiveHistoryRecoveryFreeze = {
  handle: HistoryRecoveryFreeze
  fingerprint?: TerminalHistoryDirectoryFingerprint
}

export function isTerminalHistoryQuarantineEntry(name: string): boolean {
  return name === QUARANTINE_DIR_NAME
}

export function getTerminalHistoryQuarantineOwnerDir(basePath: string, sessionId: string): string {
  const sessionHash = createHash('sha256').update(sessionId).digest('hex')
  return join(basePath, QUARANTINE_DIR_NAME, sessionHash)
}

// Why process-wide and not a HistoryManager field: the freeze lives in this process's memory while
// the backlog permission sweep walks the same tree from an unrelated module, and its chmod moves the
// `mode`/`ctimeMs` that fingerprintTerminalHistorySession hashes. Refcounted because the legacy and
// current daemon adapters each hold their own HistoryManager over one base path.
const recoveryFrozenSessionDirs = new Map<string, number>()

export function markTerminalHistorySessionRecoveryFrozen(sessionDir: string): void {
  const key = resolve(sessionDir)
  recoveryFrozenSessionDirs.set(key, (recoveryFrozenSessionDirs.get(key) ?? 0) + 1)
}

export function unmarkTerminalHistorySessionRecoveryFrozen(sessionDir: string): void {
  const key = resolve(sessionDir)
  const held = recoveryFrozenSessionDirs.get(key)
  if (held === undefined) {
    return
  }
  if (held > 1) {
    recoveryFrozenSessionDirs.set(key, held - 1)
  } else {
    recoveryFrozenSessionDirs.delete(key)
  }
}

/** True while a session tree must not be touched by anything outside its own recovery handshake:
 *  an open freeze holds a fingerprint of it, or a failed quarantine left it fail-closed on disk. */
export function isTerminalHistorySessionDirRecoveryProtected(sessionDir: string): boolean {
  return (
    recoveryFrozenSessionDirs.has(resolve(sessionDir)) ||
    existsSync(join(sessionDir, RECOVERY_PROTECTION_MARKER))
  )
}

export function hasTerminalHistoryRecoveryProtection(basePath: string, sessionId: string): boolean {
  return existsSync(join(basePath, getHistorySessionDirName(sessionId), RECOVERY_PROTECTION_MARKER))
}

export function clearTerminalHistoryRecoveryProtection(dir: string): void {
  try {
    unlinkSync(join(dir, RECOVERY_PROTECTION_MARKER))
  } catch {
    // Missing or locked markers remain fail-closed.
  }
}

export function fingerprintTerminalHistorySession(
  basePath: string,
  sessionId: string
): TerminalHistoryDirectoryFingerprint {
  const sessionDir = join(basePath, getHistorySessionDirName(sessionId))
  if (!existsSync(sessionDir)) {
    return null
  }

  const fingerprint = createHash('sha256')
  const entries = readdirSync(sessionDir).sort()
  for (const name of ['.', ...entries]) {
    const stats = lstatSync(name === '.' ? sessionDir : join(sessionDir, name))
    fingerprint.update(name)
    fingerprint.update('\0')
    fingerprint.update(
      [stats.dev, stats.ino, stats.mode, stats.size, stats.mtimeMs, stats.ctimeMs].join(':')
    )
    fingerprint.update('\0')
  }
  return fingerprint.digest('hex')
}

export function quarantineTerminalHistorySession(
  basePath: string,
  sessionId: string,
  expectedFingerprint: TerminalHistoryDirectoryFingerprint
): string {
  const actualFingerprint = fingerprintTerminalHistorySession(basePath, sessionId)
  if (actualFingerprint !== expectedFingerprint) {
    throw new Error('terminal_history_recovery_generation_changed')
  }

  const sessionDir = join(basePath, getHistorySessionDirName(sessionId))
  const ownerDir = getTerminalHistoryQuarantineOwnerDir(basePath, sessionId)
  // Why: if rename is blocked, a later adapter must not attach a writer to the unreadable generation.
  writeFileSync(join(sessionDir, RECOVERY_PROTECTION_MARKER), '', { mode: PRIVATE_FILE_MODE })
  ensurePrivateDir(ownerDir)
  const quarantineDir = join(ownerDir, randomUUID())
  renameSync(sessionDir, quarantineDir)
  return quarantineDir
}
