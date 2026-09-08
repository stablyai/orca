import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionSearchCapturedMessage } from './session-search-capture'
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
  // Set when the caller parses inside a search-capture scope: AsyncLocalStorage
  // does not cross threads, so the worker sends acknowledged capture batches.
  capture?: boolean
}

export type OpenCodeSqliteWorkerRequest = OpenCodeSqliteListRequest | OpenCodeSqliteParseRequest

// The list leg returns candidates plus the issues it accumulated; the worker
// mutates a local array and hands it back so the caller can merge it into the
// scan's shared issue list.
export type OpenCodeSqliteListValue = {
  candidates: SessionFileCandidate[]
  issues: AiVaultScanIssue[]
}

// Final metadata follows acknowledgement of every capture batch.
export type OpenCodeSqliteParseValue = {
  session: AiVaultSession | null
  // Set when a read degraded mid-session: the batches sent are not the whole
  // transcript, so the parent must refuse to publish this file's cursor.
  captureIncomplete?: boolean
}

// One acknowledged slice of a parse's index rows, sent before that parse's
// result. `batch` numbers them so a late ack cannot release the wrong one.
export type OpenCodeSqliteCaptureBatch = {
  id: number
  kind: 'batch'
  batch: number
  messages: SessionSearchCapturedMessage[]
}

export type OpenCodeSqliteWorkerResult = { id: number; kind: 'result'; value: unknown }
export type OpenCodeSqliteWorkerFailure = { id: number; kind: 'error'; error: string }

// Tagged rather than a boolean plus an optional field: the tag is what lets the
// client narrow to the batch shape without casting its payload.
export type OpenCodeSqliteWorkerResponse =
  | OpenCodeSqliteCaptureBatch
  | OpenCodeSqliteWorkerResult
  | OpenCodeSqliteWorkerFailure

export type OpenCodeSqliteCaptureAck = { id: number; kind: 'captureAck'; batch: number }
export type OpenCodeSqliteParentMessage = OpenCodeSqliteWorkerRequest | OpenCodeSqliteCaptureAck

export type OpenCodeSqliteRequestBody =
  | Omit<OpenCodeSqliteListRequest, 'id'>
  | Omit<OpenCodeSqliteParseRequest, 'id'>
