// History contains terminal content and runtime files contain auth tokens; pin modes instead of trusting umask.

import { chmodSync, existsSync, mkdirSync } from 'node:fs'

export const PRIVATE_DIR_MODE = 0o700
export const PRIVATE_FILE_MODE = 0o600

/** Windows ignores POSIX mode bits and can reject chmod outright; hardening must never break a write. */
export function supportsPosixFileModes(): boolean {
  return process.platform !== 'win32'
}

/** Repair paths created by older daemons without making writes depend on chmod. */
export function tightenPathMode(path: string, mode: number): void {
  if (!supportsPosixFileModes()) {
    return
  }
  try {
    if (existsSync(path)) {
      chmodSync(path, mode)
    }
  } catch {
    // Read-only volumes, foreign ownership, exotic filesystems: leave the mode as found.
  }
}

// mkdir mode does not repair a directory that already exists.
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
  tightenPathMode(dir, PRIVATE_DIR_MODE)
}
