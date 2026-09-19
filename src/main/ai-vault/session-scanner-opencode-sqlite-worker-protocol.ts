import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from './session-scanner-types'
import type { TranscriptMessage } from './session-transcript-consumers'

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

// Same arguments as `parse`, different answer: the session plus every message
// the session holds. Its own kind rather than a flag on `parse` so the two
// response shapes stay distinguishable at the type level on both sides.
export type OpenCodeSqliteCaptureRequest = {
  id: number
  kind: 'capture'
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
}

export type OpenCodeSqliteWorkerRequest =
  | OpenCodeSqliteListRequest
  | OpenCodeSqliteParseRequest
  | OpenCodeSqliteCaptureRequest

// The list leg returns candidates plus the issues it accumulated; the worker
// mutates a local array and hands it back so the caller can merge it into the
// scan's shared issue list.
export type OpenCodeSqliteListValue = {
  candidates: SessionFileCandidate[]
  issues: AiVaultScanIssue[]
}

// The session the panel shows, and the transcript the search index folds. Both
// come from one open of the database, so the two can never disagree about which
// generation of the session they describe.
export type OpenCodeSqliteCaptureValue = {
  session: AiVaultSession | null
  messages: TranscriptMessage[]
}

export type OpenCodeSqliteWorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }
