import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getHistorySessionDirName } from './history-paths'
import { isValidTerminalHistorySize } from './terminal-history-dimensions'
import { readTerminalHistoryJson } from './terminal-history-file-reader'
import { TERMINAL_HISTORY_META_MAX_BYTES } from './terminal-history-file-limits'

export type SessionMeta = {
  cwd: string
  cols: number
  rows: number
  startedAt: string
  endedAt: string | null
  exitCode: number | null
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
    // Why: a concurrent cleanup/quarantine between existsSync and the read means no history, not corrupt history.
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

export function updateTerminalHistoryMeta(dir: string, updates: Partial<SessionMeta>): void {
  const meta = readTerminalHistoryMetaFromDir(dir)
  if (!meta) {
    return
  }
  Object.assign(meta, updates)
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
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
    (meta.exitCode === null || typeof meta.exitCode === 'number')
  )
}
