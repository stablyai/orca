// The files one terminal-history session tree owns, and the whole-tree operations over them.
// Single list so the stale-file reset and the permission tightening cannot drift apart.

import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, tightenPathMode } from './daemon-private-file-modes'

export const TERMINAL_HISTORY_SESSION_FILE_NAMES = [
  'checkpoint.json',
  'output.log',
  'meta.json',
  'scrollback.bin'
] as const

// meta.json survives: a reset re-anchors replayable state, not the session's identity.
const REPLAYABLE_SESSION_FILE_NAMES = ['checkpoint.json', 'scrollback.bin', 'output.log'] as const

/** Why: a crash before the first checkpoint must not replay a cleanly ended prior session. */
export function clearReplayableTerminalHistorySessionFiles(dir: string): void {
  for (const name of REPLAYABLE_SESSION_FILE_NAMES) {
    try {
      unlinkSync(join(dir, name))
    } catch {
      // ENOENT is expected for new sessions.
    }
  }
}

/** Idempotent and ~5 syscalls: tighten one session tree as it is opened for writing. Needed because
 *  `mode` on writeFile only applies at creation, so files an older daemon left at umask stay open. */
export function tightenTerminalHistorySessionDirMode(dir: string): void {
  tightenPathMode(dir, PRIVATE_DIR_MODE)
  for (const name of TERMINAL_HISTORY_SESSION_FILE_NAMES) {
    tightenPathMode(join(dir, name), PRIVATE_FILE_MODE)
  }
}
