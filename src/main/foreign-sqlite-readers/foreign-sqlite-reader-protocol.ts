// Keep this Electron-free so both worker and main-process clients can import it.

import type { OpenCodeSessionCursor } from './opencode-binder-sessions-result'
import type { OpenCodePromptFailureQuery } from './opencode-prompt-failure-result'

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

type OpenCodePromptFailureRequest = OpenCodePromptFailureQuery & {
  id: number
  kind: 'openCodePromptFailure'
}

export type ForeignSqliteReaderRequest =
  | CursorProfileRequest
  | OpenCodeBinderSessionsRequest
  | OpenCodePromptFailureRequest

export type ForeignSqliteReaderKind = ForeignSqliteReaderRequest['kind']

export type ForeignSqliteReaderResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }
