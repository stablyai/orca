import { existsSync, promises as fsPromises, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { errnoCodeOrUnknown } from '../../../../shared/errno-code'
import { provesTerminalHistoryPathAbsent } from './terminal-history-session-files'
import { getHistorySessionDirName } from './history-paths'
import { isValidTerminalHistorySize } from '../restoration/terminal-history-dimensions'
import {
  readTerminalHistoryJson,
  readTerminalHistoryJsonAsync,
  readTerminalHistoryTextAsync
} from './terminal-history-file-reader'
import { TERMINAL_HISTORY_META_MAX_BYTES } from './terminal-history-file-limits'
import {
  isTerminalHistoryCwdObservation,
  type TerminalHistoryCwdObservation
} from './terminal-history-cwd-observation'
import {
  PRIVATE_FILE_MODE,
  tightenPathMode,
  tightenPathModeAsync
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
    return validatedMetaRead(
      readTerminalHistoryJson<unknown>(metaPath, TERMINAL_HISTORY_META_MAX_BYTES)
    )
  } catch (err) {
    // Concurrent cleanup or quarantine can remove metadata between the existence check and read.
    if (errnoCodeOrUnknown(err) === 'ENOENT') {
      return { status: 'missing' }
    }
    return { status: 'unreadable' }
  }
}

/** Bounded and awaited: only a confirmed missing file is missing; any other failure is unreadable. */
export async function readTerminalHistoryMetaInDirAsync(dir: string): Promise<SessionMetaRead> {
  let meta: unknown
  try {
    meta = await readTerminalHistoryJsonAsync<unknown>(
      join(dir, 'meta.json'),
      TERMINAL_HISTORY_META_MAX_BYTES
    )
  } catch (error) {
    return provesTerminalHistoryPathAbsent(error) ? { status: 'missing' } : { status: 'unreadable' }
  }
  return validatedMetaRead(meta)
}

function validatedMetaRead(meta: unknown): SessionMetaRead {
  if (!isSessionMeta(meta)) {
    return { status: 'unreadable' }
  }
  // A malformed note is ignored; the rest of the metadata still holds the session.
  if (meta.cwdObservation !== undefined && !isTerminalHistoryCwdObservation(meta.cwdObservation)) {
    delete meta.cwdObservation
  }
  return { status: 'readable', meta }
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
 * Replaces existing valid metadata under its owner: bounded read, private temporary file, owner
 * check, rename, bounded readback. The caller owns every issued step through settlement, cleanup
 * included; a failure leaves the published metadata in place and never unlinks it.
 */
export function replaceTerminalHistoryMetaOwned(
  dir: string,
  next: (current: SessionMeta) => SessionMeta,
  isOwner: () => boolean
): Promise<TerminalHistoryMetaReplacement> {
  return publishTerminalHistoryMetaOwned(dir, (current) => current && next(current), isOwner)
}

/** A new hold's metadata, only where none exists; metadata that appeared meanwhile stays. */
export function createTerminalHistoryMetaOwned(
  dir: string,
  meta: SessionMeta,
  isOwner: () => boolean
): Promise<TerminalHistoryMetaReplacement> {
  return publishTerminalHistoryMetaOwned(dir, (current) => (current ? null : meta), isOwner, true)
}

async function publishTerminalHistoryMetaOwned(
  dir: string,
  next: (current: SessionMeta | null) => SessionMeta | null,
  isOwner: () => boolean,
  create = false
): Promise<TerminalHistoryMetaReplacement> {
  const metaPath = join(dir, 'meta.json')
  const tmpPath = `${metaPath}.tmp`
  let current: SessionMeta | null = null
  try {
    const read = await readTerminalHistoryJsonAsync<unknown>(
      metaPath,
      TERMINAL_HISTORY_META_MAX_BYTES
    )
    if (!isSessionMeta(read)) {
      return 'unavailable'
    }
    current = read
  } catch (error) {
    if (!create || !provesTerminalHistoryPathAbsent(error)) {
      return 'unavailable'
    }
  }
  const value = next(current)
  if (!value || !isOwner()) {
    return 'unavailable'
  }
  const data = JSON.stringify(value, null, 2)
  if (Buffer.byteLength(data, 'utf8') > TERMINAL_HISTORY_META_MAX_BYTES) {
    return 'unrepresentable'
  }
  // Only a temporary file this call issued is its to remove.
  let issued = false
  try {
    if (!isOwner()) {
      return 'unavailable'
    }
    issued = true
    await fsPromises.writeFile(tmpPath, data, { mode: PRIVATE_FILE_MODE })
    await tightenPathModeAsync(tmpPath, PRIVATE_FILE_MODE)
    if (!isOwner()) {
      throw new Error('terminal_history_owner_changed')
    }
    await fsPromises.rename(tmpPath, metaPath)
    issued = false
    const readback = await readTerminalHistoryTextAsync(metaPath, TERMINAL_HISTORY_META_MAX_BYTES)
    return readback === data ? 'replaced' : 'unavailable'
  } catch {
    if (issued) {
      await fsPromises.unlink(tmpPath).catch(() => {})
    }
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
