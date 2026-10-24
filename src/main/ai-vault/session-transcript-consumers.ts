import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from './session-scanner-types'

// Publish reads so new consumers do not require reader or cache changes.

export type TranscriptMessageRole = 'user' | 'assistant' | 'tool'

export type TranscriptMessage = {
  role: TranscriptMessageRole
  /** Decoded text, subject to the reader's safety limits. */
  text: string
  /** A size limit omitted some decoded text. */
  textTruncated?: true
  timestamp: string | null
}

export type TranscriptMessageSink = {
  /** False when nobody is listening: parsers skip the extraction entirely. */
  readonly active: boolean
  push(message: TranscriptMessage): void
  /** A later duplicate JSON array replaces every message emitted from the earlier array. */
  reset?: () => void
}

export const NO_TRANSCRIPT_MESSAGES: TranscriptMessageSink = {
  active: false,
  push: () => undefined
}

/** Provisional mid-read identity; later records can change titles, paths, and timestamps. */
export type TranscriptSessionIdentity = {
  sessionId: string
  cwd: string | null
  title: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type TranscriptReadStart = {
  candidate: SessionFileCandidate
  /** `replace`: the whole file is being re-read; `append`: a resumed read. */
  mode: 'replace' | 'append'
  /** Byte offset the messages of this read continue from. */
  previousByteOffset: number
  /** Query during the read after decoding begins; absent for parsers without resumable state. */
  identity?: () => TranscriptSessionIdentity | null
}

export type TranscriptReadOutcome = {
  /** Null when the parser rejected the file, such as an excluded Codex worker transcript. */
  session: AiVaultSession | null
  /** Byte offset just past the last complete line this read consumed. */
  byteOffset: number
  /** Incomplete streams must not advance consumer cursors. */
  incomplete: boolean
  /** Cancellation leaves the file pending without recording a failure. */
  cancelled?: boolean
}

export type TranscriptReadConsumer = {
  message(message: TranscriptMessage): void
  finish(outcome: TranscriptReadOutcome): void
}

export type TranscriptConsumer = {
  /** Decline reads whose previousByteOffset exceeds your cursor, then request a whole read separately. */
  beginRead(start: TranscriptReadStart): TranscriptReadConsumer | null
}

const consumers = new Set<TranscriptConsumer>()

export function registerTranscriptConsumer(consumer: TranscriptConsumer): () => void {
  consumers.add(consumer)
  return () => {
    consumers.delete(consumer)
  }
}

export function transcriptConsumers(): readonly TranscriptConsumer[] {
  return [...consumers]
}

export function hasTranscriptConsumers(): boolean {
  return consumers.size > 0
}

export function resetTranscriptConsumersForTests(): void {
  consumers.clear()
}
