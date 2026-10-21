// Mode primitives for daemon-owned on-disk state. Terminal history persists verbatim screen and
// scrollback (checkpoint.json holds snapshotAnsi + scrollbackAnsi) and the runtime dir holds the
// daemon's auth token, so neither may be left at whatever umask applies to other local users.

import { chmodSync, existsSync, mkdirSync } from 'node:fs'

export const PRIVATE_DIR_MODE = 0o700
export const PRIVATE_FILE_MODE = 0o600

/** Windows ignores POSIX mode bits and can reject chmod outright; hardening must never break a write. */
export function supportsPosixFileModes(): boolean {
  return process.platform !== 'win32'
}

/** Best-effort repair for a path created before modes were pinned (or by an older daemon). */
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

/** mkdir with the private mode, plus a chmod repair for a directory that already existed. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
  tightenPathMode(dir, PRIVATE_DIR_MODE)
}
