import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from './session-scanner-types'

// Why: request/response shapes shared by the worker entry and the main-thread
// client. Kept type-only (and electron-free) so importing it into the worker
// bundle can never pull the client's Electron dependency across the boundary.

export type OpenCodeSqliteListRequest = {
  id: number
  kind: 'list'
  dbPaths: readonly string[]
  limit: number
  source?: 'opencode'
}

export type OpenCodeSqliteParseRequest = {
  id: number
  kind: 'parse'
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  source?: 'opencode'
}

export type HermesSqliteListRequest = {
  id: number
  kind: 'list'
  dbPaths: readonly string[]
  limit?: number
  profileNames?: readonly (string | null)[]
  source: 'hermes'
}

export type HermesSqliteParseRequest = {
  id: number
  kind: 'parse'
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  profileName?: string | null
  source: 'hermes'
}

export type OpenCodeSqliteWorkerRequest =
  | OpenCodeSqliteListRequest
  | OpenCodeSqliteParseRequest
  | HermesSqliteListRequest
  | HermesSqliteParseRequest

export type OpenCodeSqliteWorkerRequestBody =
  | Omit<OpenCodeSqliteListRequest, 'id'>
  | Omit<OpenCodeSqliteParseRequest, 'id'>
  | Omit<HermesSqliteListRequest, 'id'>
  | Omit<HermesSqliteParseRequest, 'id'>

// The list leg returns candidates plus the issues it accumulated; the worker
// mutates a local array and hands it back so the caller can merge it into the
// scan's shared issue list.
export type OpenCodeSqliteListValue = {
  candidates: SessionFileCandidate[]
  issues: AiVaultScanIssue[]
}

export type OpenCodeSqliteParseValue = AiVaultSession | null

export type OpenCodeSqliteWorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }
