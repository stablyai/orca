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
  /** Offsets where this replacement read reports the digest of the bytes before them. */
  prefixOffsets?: ReadonlySet<number>
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
  /** SHA-256 of bytes [0, byteOffset); absent when the read could not hash its whole prefix. */
  prefixHash?: string
}

export type TranscriptReadConsumer = {
  message(message: TranscriptMessage): void
  finish(outcome: TranscriptReadOutcome): void
  /** The read has consumed exactly [0, offset), whose bytes hash to digest. */
  prefixReached?(offset: number, digest: string): void
}

export type TranscriptConsumer = {
  /** Decline reads whose previousByteOffset exceeds your cursor, then request a whole read separately. */
  beginRead(start: TranscriptReadStart): TranscriptReadConsumer | null
  /** Cursor this consumer could resume at if a replacement read proves the bytes before it unchanged. */
  resumableOffset?(candidate: SessionFileCandidate): number | null
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

export function transcriptResumableOffsets(candidate: SessionFileCandidate): Set<number> {
  const offsets = new Set<number>()
  for (const consumer of consumers) {
    try {
      const offset = consumer.resumableOffset?.(candidate)
      if (typeof offset === 'number' && offset > 0) {
        offsets.add(offset)
      }
    } catch {
      // A consumer failure only costs that consumer its resume.
    }
  }
  return offsets
}

export function hasTranscriptConsumers(): boolean {
  return consumers.size > 0
}

export function resetTranscriptConsumersForTests(): void {
  consumers.clear()
}
