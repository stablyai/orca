import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, tightenPathMode } from './daemon-private-file-modes'

export const TERMINAL_HISTORY_SESSION_FILE_NAMES = [
  'checkpoint.json',
  'output.log',
  'meta.json',
  'scrollback.bin'
] as const

// Preserve metadata identity while resetting replayable state.
const REPLAYABLE_SESSION_FILE_NAMES = ['checkpoint.json', 'scrollback.bin', 'output.log'] as const

/** A crash before the first new checkpoint must not replay a prior, cleanly ended session. */
export function clearReplayableTerminalHistorySessionFiles(dir: string): void {
  for (const name of REPLAYABLE_SESSION_FILE_NAMES) {
    try {
      unlinkSync(join(dir, name))
    } catch {}
  }
}

/** Tighten existing files too: writeFile creation modes leave older permissions unchanged. */
export function tightenTerminalHistorySessionDirMode(dir: string): void {
  tightenPathMode(dir, PRIVATE_DIR_MODE)
  for (const name of TERMINAL_HISTORY_SESSION_FILE_NAMES) {
    tightenPathMode(join(dir, name), PRIVATE_FILE_MODE)
  }
}
