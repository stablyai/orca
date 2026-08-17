import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from './session-scanner-types'

// Why: request/response shapes shared by the worker entry and the main-thread
// client. Kept type-only (and electron-free) so importing it into the worker
// bundle can never pull the client's Electron dependency across the boundary.

export type OpenCodeSqliteListRequest = {
  id: number
  kind: 'list'
  dbPaths: readonly string[]
  limit: number
}

export type OpenCodeSqliteParseRequest = {
  id: number
  kind: 'parse'
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
}

// Why: native chat reads the same DB the scanner parses, so it rides the same
// worker boundary — synchronous node:sqlite stays off the main process.
export type OpenCodeSqliteNativeChatPageRequest = {
  id: number
  kind: 'native-chat-page'
  dbPath: string
  sessionId: string
  limit: number
  beforeMessageRowId?: number
}

export type OpenCodeSqliteNativeChatSignalRequest = {
  id: number
  kind: 'native-chat-signal'
  dbPath: string
  sessionId: string
}

export type OpenCodeSqliteNativeChatPageAfterRequest = {
  id: number
  kind: 'native-chat-page-after'
  dbPath: string
  sessionId: string
  afterMessageRowId: number
  limit: number
  upToMessageRowId?: number
}

export type OpenCodeSqliteWorkerRequest =
  | OpenCodeSqliteListRequest
  | OpenCodeSqliteParseRequest
  | OpenCodeSqliteNativeChatPageRequest
  | OpenCodeSqliteNativeChatSignalRequest
  | OpenCodeSqliteNativeChatPageAfterRequest

// The list leg returns candidates plus the issues it accumulated; the worker
// mutates a local array and hands it back so the caller can merge it into the
// scan's shared issue list.
export type OpenCodeSqliteListValue = {
  candidates: SessionFileCandidate[]
  issues: AiVaultScanIssue[]
}

export type OpenCodeSqliteWorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }
