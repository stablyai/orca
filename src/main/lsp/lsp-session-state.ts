import type { ChildProcessWithoutNullStreams } from 'node:child_process'

export type PendingRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

// Why: documentsByUri is keyed by canonicalFileUriKey; keep the exact URI the
// client knows so diagnostics forwarded to the renderer match its lookups.
export type OpenDocumentState = { fileUri: string; version: number; refCount: number }

export type LspSession = {
  sessionId: string
  key: string
  serverId: string
  child: ChildProcessWithoutNullStreams
  nextRequestId: number
  pending: Map<number, PendingRequest>
  documentsByUri: Map<string, OpenDocumentState>
  initialization: Promise<void>
  // Why: pull-model servers (tsgo, TS7) advertise diagnosticProvider and never
  // push; the renderer must know which model this session speaks.
  pullDiagnostics: boolean
  idleTimer: NodeJS.Timeout | null
  disposed: boolean
}

export type LspDiagnosticsListener = (payload: {
  sessionId: string
  fileUri: string
  diagnostics: unknown[]
}) => void
