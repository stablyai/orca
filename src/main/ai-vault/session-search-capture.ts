import { AsyncLocalStorage } from 'node:async_hooks'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from './session-scanner-types'

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
  candidate: SessionFileCandidate
  /** Null when the parser rejected the file (e.g. a Codex worker transcript): drop its rows. */
  session: AiVaultSession | null
  /** `replace`: whole-file parse, rows supersede the session; `append`: resumed parse. */
  mode: 'replace' | 'append'
  messages: SessionSearchCapturedMessage[]
  /** Byte offset the appended rows continue from; the sink refuses a mismatch. */
  previousByteOffset: number
  byteOffset: number
}

export type SessionSearchFileIdentity = { dev: number; ino: number } | null

export type SessionSearchIndexedFile = {
  byteOffset: number
  mtimeMs: number
  sizeBytes: number | null
}

export type SessionSearchIndexSink = {
  /**
   * What the index holds for this file, or null when it is not indexed or its
   * identity changed. In `required` mode the parse cache may only reuse an
   * entry the index also has and may only resume when the parser's resume
   * offset equals `byteOffset`; anything else forces a whole-file parse.
   */
  indexedFile(path: string, identity: SessionSearchFileIdentity): SessionSearchIndexedFile | null
  /** Never throws: an index failure must not break the session list. */
  apply(update: SessionSearchIndexUpdate): void
  /** `opportunistic` mode saw a file the index is behind on; the backfill lane re-parses it. */
  markStale(candidate: SessionFileCandidate): void
}

// Why: list scans have a latency budget and must never pay for the index; they
// feed it only when a whole-file parse happens anyway. The backfill lane runs
// in `required` mode, where index consistency wins over parse reuse.
export type SessionSearchIndexMode = 'opportunistic' | 'required'

type CaptureScope = { messages: SessionSearchCapturedMessage[] } | null

const captureStorage = new AsyncLocalStorage<CaptureScope>()
const indexModeStorage = new AsyncLocalStorage<SessionSearchIndexMode>()
let sink: SessionSearchIndexSink | null = null

export function getSessionSearchIndexMode(): SessionSearchIndexMode {
  return indexModeStorage.getStore() ?? 'opportunistic'
}

export function withSessionSearchIndexRequired<T>(fn: () => Promise<T>): Promise<T> {
  return indexModeStorage.run('required', fn)
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

/** Runs `fn` with capture suppressed: display-only re-reads must not emit rows. */
export function withoutSessionSearchCapture<T>(fn: () => T): T {
  return captureStorage.run(null, fn)
}

export async function withSessionSearchCapture<T>(
  fn: () => Promise<T>
): Promise<{ value: T; messages: SessionSearchCapturedMessage[] }> {
  const scope = { messages: [] as SessionSearchCapturedMessage[] }
  const value = await captureStorage.run(scope, fn)
  return { value, messages: scope.messages }
}
