import { closeSync, existsSync, openSync, readSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLogHeader, LOG_HEADER_BYTES } from './terminal-history-log'
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  tightenPathMode
} from '../../endpoint/publication/daemon-private-file-modes'

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

/** The generation a log's header declares, or null when it is missing, torn or foreign. */
export function readTerminalHistoryLogHeaderGeneration(logPath: string): number | null {
  try {
    const fd = openSync(logPath, 'r')
    try {
      const header = Buffer.alloc(LOG_HEADER_BYTES)
      return readSync(fd, header, 0, LOG_HEADER_BYTES, 0) === LOG_HEADER_BYTES
        ? decodeLogHeader(header)
        : null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

export function hasReplayableTerminalHistorySessionFiles(dir: string): boolean {
  return REPLAYABLE_SESSION_FILE_NAMES.some((name) => existsSync(join(dir, name)))
}

/** Once a checkpoint supersedes it, legacy scrollback must not outlive the predecessor. */
export function clearLegacyTerminalHistoryScrollback(dir: string): void {
  try {
    unlinkSync(join(dir, 'scrollback.bin'))
  } catch {}
}

/** Tighten existing files too: writeFile creation modes leave older permissions unchanged. */
export function tightenTerminalHistorySessionDirMode(dir: string): void {
  tightenPathMode(dir, PRIVATE_DIR_MODE)
  for (const name of TERMINAL_HISTORY_SESSION_FILE_NAMES) {
    tightenPathMode(join(dir, name), PRIVATE_FILE_MODE)
  }
}
