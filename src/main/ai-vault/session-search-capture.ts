import { AsyncLocalStorage } from 'node:async_hooks'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { FileWithMtime, SessionFileCandidate } from './session-scanner-types'

// Why: the parsers already fold every provider's transcript into one
// accumulator. Instead of a second reader per format, a parse runs inside a
// capture scope and the preview funnel also emits full-text rows; incremental
// resumes emit only the newly consumed lines, which is exactly what the search
// index needs to append.

export type SessionSearchCapturedRole = 'user' | 'assistant' | 'tool'

export type SessionSearchCapturedMessage = {
  role: SessionSearchCapturedRole
  text: string
  timestamp: string | null
}

export type SessionSearchIndexUpdate = {
  signal?: AbortSignal
  candidate: SessionFileCandidate
  /** Null when the parser rejected the file (e.g. a Codex worker transcript): drop its rows. */
  session: AiVaultSession | null
  /** `replace`: whole-file parse, rows supersede the session; `append`: resumed parse. */
  mode: 'replace' | 'append'
  messages: SessionSearchCapturedMessage[] | AsyncIterable<SessionSearchCapturedMessage>
  /** Byte offset the appended rows continue from; the sink refuses a mismatch. */
  previousByteOffset: number
  byteOffset: number
}

export type SessionSearchIndexResult = Pick<SessionSearchIndexUpdate, 'session' | 'byteOffset'>

/** Final metadata and cursor arrive only when the streamed parse completes. */
export type SessionSearchIndexWrite = Omit<SessionSearchIndexUpdate, 'session' | 'byteOffset'> & {
  result: Promise<SessionSearchIndexResult>
}

export type SessionSearchFileIdentity = { dev: number; ino: number } | null

export type SessionSearchIndexedFile = {
  byteOffset: number
  mtimeMs: number
  sizeBytes: number | null
}

export type SessionSearchIndexSink = {
  acceptsCandidate?(candidate: SessionFileCandidate): boolean
  updateMetadata?(candidate: SessionFileCandidate, session: AiVaultSession): void
  /**
   * What the index holds for this file, or null when it is not indexed or its
   * identity changed. In `required` mode the parse cache may only reuse an
   * entry the index also has and may only resume when the parser's resume
   * offset equals `byteOffset`; anything else forces a whole-file parse.
   */
  indexedFile(path: string, identity: SessionSearchFileIdentity): SessionSearchIndexedFile | null
  /** Never throws: an index failure must not break the session list. */
  apply(update: SessionSearchIndexWrite): void | Promise<void>
  /** `opportunistic` mode saw a file the index is behind on; the backfill lane re-parses it. */
  markStale(candidate: SessionFileCandidate): void
}

// Why: list scans have a latency budget and must never pay for the index; they
// feed it only when a whole-file parse happens anyway. The backfill lane runs
// in `required` mode, where index consistency wins over parse reuse.
export type SessionSearchIndexMode = 'opportunistic' | 'required'

type CaptureScope = {
  messages: { push(message: SessionSearchCapturedMessage): unknown }
  checkpoint?: () => Promise<void>
  /** Producer-written; owned by whoever opened the scope. */
  degraded?: { incomplete: boolean }
} | null

/**
 * Ends the row stream of a parse whose read degraded. The writer refuses that
 * write rather than failing it: the rows are simply not the whole file.
 */
export class SessionSearchCaptureIncompleteError extends Error {}

const captureStorage = new AsyncLocalStorage<CaptureScope>()
const indexModeStorage = new AsyncLocalStorage<{
  mode: SessionSearchIndexMode
  signal?: AbortSignal
}>()
let sink: SessionSearchIndexSink | null = null

export function getSessionSearchIndexMode(): SessionSearchIndexMode {
  return indexModeStorage.getStore()?.mode ?? 'opportunistic'
}

export function getSessionSearchCaptureSignal(): AbortSignal | undefined {
  return indexModeStorage.getStore()?.signal
}

export function withSessionSearchIndexRequired<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return indexModeStorage.run({ mode: 'required', signal }, fn)
}

export function registerSessionSearchIndexSink(next: SessionSearchIndexSink | null): void {
  sink = next
}

export function getSessionSearchIndexSink(): SessionSearchIndexSink | null {
  return sink
}

export function captureSessionSearchMessage(message: SessionSearchCapturedMessage): void {
  captureStorage.getStore()?.messages.push(message)
}

export function isSessionSearchCaptureActive(): boolean {
  return captureStorage.getStore() != null
}

/**
 * Report that this parse's rows are not the whole file: a read degraded rather
 * than failed, so the session still lists, but publishing a cursor for it would
 * retire it from every later scan and leave its content unsearchable forever.
 */
export function markSessionSearchCaptureIncomplete(): void {
  const scope = captureStorage.getStore()
  if (scope?.degraded) {
    scope.degraded.incomplete = true
  }
}

/** Runs `fn` with capture suppressed: display-only re-reads must not emit rows. */
export function withoutSessionSearchCapture<T>(fn: () => T): T {
  return captureStorage.run(null, fn)
}

export async function checkpointSessionSearchCapture(): Promise<void> {
  const signal = getSessionSearchCaptureSignal()
  throwIfAiVaultScanCancelled(signal)
  await captureStorage.getStore()?.checkpoint?.()
  throwIfAiVaultScanCancelled(signal)
}

export function withStreamingSessionSearchCapture<T>(
  messages: { push(message: SessionSearchCapturedMessage): unknown; checkpoint(): Promise<void> },
  fn: () => Promise<T>,
  degraded?: { incomplete: boolean }
): Promise<T> {
  return captureStorage.run({ messages, checkpoint: () => messages.checkpoint(), degraded }, fn)
}

export function isSessionSearchFileCurrent(
  indexed: SessionSearchIndexedFile | null,
  file: FileWithMtime
): boolean {
  return (
    indexed !== null &&
    indexed.mtimeMs === file.mtimeMs &&
    (indexed.sizeBytes === null ||
      file.sizeBytes === undefined ||
      indexed.sizeBytes === file.sizeBytes)
  )
}
