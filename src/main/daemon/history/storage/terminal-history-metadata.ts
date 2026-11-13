import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getHistorySessionDirName } from './history-paths'
import { isValidTerminalHistorySize } from '../restoration/terminal-history-dimensions'
import { readTerminalHistoryJson } from './terminal-history-file-reader'
import { TERMINAL_HISTORY_META_MAX_BYTES } from './terminal-history-file-limits'
import {
  isTerminalHistoryCwdObservation,
  type TerminalHistoryCwdObservation
} from './terminal-history-cwd-observation'
import {
  PRIVATE_FILE_MODE,
  tightenPathMode
} from '../../endpoint/publication/daemon-private-file-modes'

export type SessionMeta = {
  cwd: string
  cols: number
  rows: number
  startedAt: string
  endedAt: string | null
  exitCode: number | null
  /** Absent from an older daemon's sessions (daemon-history-replay-pty.ts). */
  resizeModel?: string
  /** A probed folder ordered within this origin's history; older readers ignore it. */
  cwdObservation?: TerminalHistoryCwdObservation
}

export type SessionMetaRead =
  | { status: 'missing' }
  | { status: 'readable'; meta: SessionMeta }
  | { status: 'unreadable' }

export function readTerminalHistoryMeta(basePath: string, sessionId: string): SessionMetaRead {
  return readTerminalHistoryMetaInDir(join(basePath, getHistorySessionDirName(sessionId)))
}

export function readTerminalHistoryMetaInDir(dir: string): SessionMetaRead {
  const metaPath = join(dir, 'meta.json')
  if (!existsSync(metaPath)) {
    return { status: 'missing' }
  }
  try {
    const meta = readTerminalHistoryJson<unknown>(metaPath, TERMINAL_HISTORY_META_MAX_BYTES)
    if (!isSessionMeta(meta)) {
      return { status: 'unreadable' }
    }
    // A malformed note is ignored; the rest of the metadata still holds the session.
    if (
      meta.cwdObservation !== undefined &&
      !isTerminalHistoryCwdObservation(meta.cwdObservation)
    ) {
      delete meta.cwdObservation
    }
    return { status: 'readable', meta }
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

export type TerminalHistoryMetaReplacement = 'replaced' | 'unavailable' | 'unrepresentable'

/**
 * Replaces existing valid metadata in one synchronous turn under its owner: private temporary
 * file, owner check, rename, then readback. A failure leaves the published metadata in place.
 */
export function replaceTerminalHistoryMetaOwned(
  dir: string,
  next: (current: SessionMeta) => SessionMeta,
  isOwner: () => boolean
): TerminalHistoryMetaReplacement {
  const metaPath = join(dir, 'meta.json')
  const tmpPath = `${metaPath}.tmp`
  let current: unknown
  try {
    current = readTerminalHistoryJson<unknown>(metaPath, TERMINAL_HISTORY_META_MAX_BYTES)
  } catch {
    return 'unavailable'
  }
  if (!isSessionMeta(current) || !isOwner()) {
    return 'unavailable'
  }
  const data = JSON.stringify(next(current), null, 2)
  if (Buffer.byteLength(data, 'utf8') > TERMINAL_HISTORY_META_MAX_BYTES) {
    return 'unrepresentable'
  }
  try {
    writeFileSync(tmpPath, data, { mode: PRIVATE_FILE_MODE })
    tightenPathMode(tmpPath, PRIVATE_FILE_MODE)
    if (!isOwner()) {
      throw new Error('terminal_history_owner_changed')
    }
    renameSync(tmpPath, metaPath)
    return readFileSync(metaPath, 'utf8') === data ? 'replaced' : 'unavailable'
  } catch {
    try {
      unlinkSync(tmpPath)
    } catch {}
    return 'unavailable'
  }
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
