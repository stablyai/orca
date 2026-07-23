import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'
import { TERMINAL_HISTORY_META_MAX_BYTES } from './terminal-history-file-limits'
import { readTerminalHistoryJson } from './terminal-history-file-reader'

export type SessionMeta = {
  cwd: string
  cols: number
  rows: number
  startedAt: string
  endedAt: string | null
  exitCode: number | null
}

export type OpenSessionOptions = {
  cwd: string
  cols: number
  rows: number
}

export type HistoryManagerOptions = {
  onWriteError?: (sessionId: string, error: Error) => void
}

export function stringifyTerminalHistorySessionMeta(meta: SessionMeta): string {
  // Preflight compact JSON before materializing the larger pretty representation.
  stringifyJsonWithinByteLimit(meta, TERMINAL_HISTORY_META_MAX_BYTES)
  const serialized = JSON.stringify(meta, null, 2)
  if (Buffer.byteLength(serialized, 'utf8') > TERMINAL_HISTORY_META_MAX_BYTES) {
    throw new Error('Terminal history metadata exceeds its byte limit')
  }
  return serialized
}

export function readTerminalHistorySessionMeta(filePath: string): SessionMeta {
  return readTerminalHistoryJson<SessionMeta>(filePath, TERMINAL_HISTORY_META_MAX_BYTES)
}
