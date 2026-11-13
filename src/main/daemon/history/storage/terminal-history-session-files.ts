import { promises as fsPromises, unlinkSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { errnoCodeOrUnknown } from '../../../../shared/errno-code'
import { decodeLogHeader, LOG_HEADER_BYTES } from './terminal-history-log'
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  tightenPathMode,
  tightenPathModeAsync
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

/** A log's declared generation (null when torn or foreign) and size, read through one handle. */
export async function readTerminalHistoryLogHeader(
  logPath: string
): Promise<{ generation: number | null; bytes: number } | null> {
  let handle: FileHandle
  try {
    handle = await fsPromises.open(logPath, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await handle.stat()
    const header = Buffer.alloc(LOG_HEADER_BYTES)
    const { bytesRead } = await handle.read(header, 0, LOG_HEADER_BYTES, 0)
    return {
      generation: bytesRead === LOG_HEADER_BYTES ? decodeLogHeader(header) : null,
      bytes: size
    }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

/** The kernel's proof a path does not exist; access and read failures prove nothing. */
export function provesTerminalHistoryPathAbsent(error: unknown): boolean {
  const code = errnoCodeOrUnknown(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Only a confirmed missing path is absent; one that cannot be read may still be recovery. */
export async function terminalHistoryPathMayExist(path: string): Promise<boolean> {
  try {
    await fsPromises.stat(path)
    return true
  } catch (error) {
    return !provesTerminalHistoryPathAbsent(error)
  }
}

export async function hasReplayableTerminalHistorySessionFiles(dir: string): Promise<boolean> {
  for (const name of REPLAYABLE_SESSION_FILE_NAMES) {
    if (await terminalHistoryPathMayExist(join(dir, name))) {
      return true
    }
  }
  return false
}

/** Once a checkpoint supersedes it, legacy scrollback must not outlive the predecessor. */
export async function clearLegacyTerminalHistoryScrollback(dir: string): Promise<void> {
  await fsPromises.unlink(join(dir, 'scrollback.bin')).catch(() => {})
}

/** Tighten existing files too: writeFile creation modes leave older permissions unchanged. */
export function tightenTerminalHistorySessionDirMode(dir: string): void {
  tightenPathMode(dir, PRIVATE_DIR_MODE)
  for (const name of TERMINAL_HISTORY_SESSION_FILE_NAMES) {
    tightenPathMode(join(dir, name), PRIVATE_FILE_MODE)
  }
}

/** The awaited form a runtime host writer runs before it touches these files. */
export async function tightenTerminalHistorySessionDirModeAsync(dir: string): Promise<void> {
  await tightenPathModeAsync(dir, PRIVATE_DIR_MODE)
  for (const name of TERMINAL_HISTORY_SESSION_FILE_NAMES) {
    await tightenPathModeAsync(join(dir, name), PRIVATE_FILE_MODE)
  }
}
