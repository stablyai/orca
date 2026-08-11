import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

const HISTORY_DIR_NAME = 'terminal-history'
const HISTORY_DIR_NAME_WSL = 'terminal-history-wsl'
// Why: rename live history out of the way first so a quit mid-rm still leaves a durable tombstone GC can finish.
export const PENDING_DELETE_DIR_NAME = '.pending-delete'

/** First 16 hex chars of SHA-256 of the worktreeId. */
export function hashWorktreeId(worktreeId: string): string {
  return createHash('sha256').update(worktreeId).digest('hex').slice(0, 16)
}

export function getHistoryRoot(): string {
  return join(app.getPath('userData'), HISTORY_DIR_NAME)
}

export function getHistoryRootWsl(distro: string): string {
  return join(app.getPath('userData'), HISTORY_DIR_NAME_WSL, distro)
}

/** Every per-distro WSL history root that exists on disk; empty when WSL history was never written. */
export function listWslHistoryRoots(): string[] {
  const wslRoot = join(app.getPath('userData'), HISTORY_DIR_NAME_WSL)
  if (!existsSync(wslRoot)) {
    return []
  }
  try {
    return readdirSync(wslRoot).map((distro) => join(wslRoot, distro))
  } catch {
    return []
  }
}
