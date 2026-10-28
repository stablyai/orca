// Keep this Electron-free so both worker and main-process clients can import it.

import type { OpenCodeSessionCursor } from './opencode-binder-sessions-result'

type CursorProfileRequest = {
  id: number
  kind: 'cursorProfile'
  dbPath: string
}

type OpenCodeBinderSessionsRequest = {
  id: number
  kind: 'openCodeBinderSessions'
  dbPath: string
  cursor: OpenCodeSessionCursor
}

export type ForeignSqliteReaderRequest = CursorProfileRequest | OpenCodeBinderSessionsRequest

export type ForeignSqliteReaderKind = ForeignSqliteReaderRequest['kind']

export type ForeignSqliteReaderResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }
