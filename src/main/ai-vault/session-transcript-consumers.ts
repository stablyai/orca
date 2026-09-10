import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from './session-scanner-types'

// Why: the transcript reader owns discovery, per-file cursors and decoding; a
// consumer only folds the message stream. Registering a second consumer (a
// search index, a digest) must not require touching the reader or the parse
// cache, so the reader publishes reads rather than knowing who reads them.

export type TranscriptMessageRole = 'user' | 'assistant' | 'tool'

export type TranscriptMessage = {
  role: TranscriptMessageRole
  /** Untruncated decoded text; caps and redaction are consumer policy. */
  text: string
  timestamp: string | null
}

/** Where a parser hands its decoded messages; the reader supplies the instance. */
export type TranscriptMessageSink = {
  /** False when nobody is listening: parsers skip the extraction entirely. */
  readonly active: boolean
  push(message: TranscriptMessage): void
}

export const NO_TRANSCRIPT_MESSAGES: TranscriptMessageSink = {
  active: false,
  push: () => undefined
}

export type TranscriptReadStart = {
  candidate: SessionFileCandidate
  /** `replace`: the whole file is being re-read; `append`: a resumed read. */
  mode: 'replace' | 'append'
  /** Byte offset the messages of this read continue from. */
  previousByteOffset: number
}

export type TranscriptReadOutcome = {
  /** Null when the parser rejected the file (an excluded Codex worker transcript). */
  session: AiVaultSession | null
  /** Byte offset just past the last complete line this read consumed. */
  byteOffset: number
  /**
   * The messages of this read are not the whole span: the read failed part way,
   * or the parser decodes where the channel cannot reach it. A consumer must
   * not record a cursor for an incomplete read.
   */
  incomplete: boolean
}

/** One consumer's view of one file read. */
export type TranscriptReadConsumer = {
  message(message: TranscriptMessage): void
  finish(outcome: TranscriptReadOutcome): void
}

export type TranscriptConsumer = {
  /**
   * Open this read, or return null to ignore it. A consumer whose own cursor is
   * behind `previousByteOffset` declines here and re-reads on its own schedule;
   * it must never ask another consumer where it is.
   */
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
