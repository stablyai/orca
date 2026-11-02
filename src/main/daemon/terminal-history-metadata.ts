import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getHistorySessionDirName } from './history-paths'
import { isValidTerminalHistorySize } from './terminal-history-dimensions'
import { readTerminalHistoryJson } from './terminal-history-file-reader'
import { TERMINAL_HISTORY_META_MAX_BYTES } from './terminal-history-file-limits'
import { PRIVATE_FILE_MODE, tightenPathMode } from './daemon-private-file-modes'

export type SessionMeta = {
  cwd: string
  cols: number
  rows: number
  startedAt: string
  endedAt: string | null
  exitCode: number | null
  /** Absent from an older daemon's sessions (daemon-history-replay-pty.ts). */
  resizeModel?: string
}

export type SessionMetaRead =
  | { status: 'missing' }
  | { status: 'readable'; meta: SessionMeta }
  | { status: 'unreadable' }

export function readTerminalHistoryMeta(basePath: string, sessionId: string): SessionMetaRead {
  const metaPath = join(basePath, getHistorySessionDirName(sessionId), 'meta.json')
  if (!existsSync(metaPath)) {
    return { status: 'missing' }
  }
  try {
    const meta = readTerminalHistoryJson<unknown>(metaPath, TERMINAL_HISTORY_META_MAX_BYTES)
    return isSessionMeta(meta) ? { status: 'readable', meta } : { status: 'unreadable' }
  } catch (err) {
    // Concurrent cleanup or quarantine can remove metadata between the existence check and read.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { status: 'missing' }
    }
    return { status: 'unreadable' }
  }
}

export function readTerminalHistoryMetaFromDir(dir: string): SessionMeta | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'))
  } catch {
    return null
  }
}

/** A new session's meta, stamped with the resize model of the daemon hosting it. */
export function newTerminalHistoryMeta(
  opts: Pick<SessionMeta, 'cwd' | 'cols' | 'rows'>,
  resizeModel: string | null
): SessionMeta {
  return {
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    ...(resizeModel ? { resizeModel } : {})
  }
}

/** Restamps the model a fresh log is recorded against; null drops it (an older daemon). */
export function stampTerminalHistoryResizeModel(dir: string, resizeModel: string | null): void {
  const meta = readTerminalHistoryMetaFromDir(dir)
  if (!meta || meta.resizeModel === (resizeModel ?? undefined)) {
    return
  }
  const { resizeModel: _previous, ...rest } = meta
  writeTerminalHistoryMeta(dir, resizeModel ? { ...rest, resizeModel } : rest)
}

export function writeTerminalHistoryMeta(dir: string, meta: SessionMeta): void {
  const metaPath = join(dir, 'meta.json')
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), { mode: PRIVATE_FILE_MODE })
  // Creation modes do not tighten existing files from older daemons.
  tightenPathMode(metaPath, PRIVATE_FILE_MODE)
}

export function updateTerminalHistoryMeta(dir: string, updates: Partial<SessionMeta>): void {
  const meta = readTerminalHistoryMetaFromDir(dir)
  if (!meta) {
    return
  }
  Object.assign(meta, updates)
  writeTerminalHistoryMeta(dir, meta)
}

function isSessionMeta(value: unknown): value is SessionMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const meta = value as Partial<SessionMeta>
  return (
    typeof meta.cwd === 'string' &&
    typeof meta.startedAt === 'string' &&
    isValidTerminalHistorySize(meta.cols, meta.rows) &&
    (meta.endedAt === null || typeof meta.endedAt === 'string') &&
    (meta.exitCode === null || typeof meta.exitCode === 'number') &&
    (meta.resizeModel === undefined || typeof meta.resizeModel === 'string')
  )
}
