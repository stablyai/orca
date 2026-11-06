import { createHash } from 'node:crypto'
import type { AgentJournalBoundedPayload } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { boundPayload, utf8Head } from '../agent-session-journal/journal-payload-bounds'

/** UTF-8 encodes an unpaired surrogate as U+FFFD. */
const LONE_SURROGATE_BYTES = 3

/**
 * Running sha256 and UTF-8 length of a stream's retained text, so a bounded preview of growing
 * output reads only its head instead of joining and hashing everything streamed so far.
 */
export class AgentSessionDeltaDigest {
  private hash = createHash('sha256')
  private hashedBytes = 0
  /** A trailing high surrogate waits for the next delta: joined with a low one it is one character. */
  private pendingHigh = ''

  append(delta: string): void {
    let text = this.pendingHigh + delta
    this.pendingHigh = ''
    if (isHighSurrogate(text.charCodeAt(text.length - 1))) {
      this.pendingHigh = text.slice(-1)
      text = text.slice(0, -1)
    }
    this.hash.update(text, 'utf8')
    this.hashedBytes += Buffer.byteLength(text, 'utf8')
  }

  /** The coalescer replaced its chunks (truncation); describe the retained text from scratch. */
  reset(chunks: readonly string[]): void {
    this.hash = createHash('sha256')
    this.hashedBytes = 0
    this.pendingHigh = ''
    this.append(chunks.join(''))
  }

  /** Equal to boundPayload(chunks.join(''), headBytes) without materializing past the head. */
  payload(chunks: readonly string[], headBytes: number): AgentJournalBoundedPayload {
    const hash = this.hash.copy()
    if (this.pendingHigh) {
      hash.update(this.pendingHigh, 'utf8')
    }
    const byteLength = this.hashedBytes + (this.pendingHigh ? LONE_SURROGATE_BYTES : 0)
    const digest = hash.digest('hex')
    if (byteLength <= headBytes) {
      return { head: chunks.join(''), byteLength, digest, truncated: false }
    }
    // Per-chunk sizes overcount pairs split across chunks, so confirm on the joined prefix.
    const wanted = headBytes + LONE_SURROGATE_BYTES + 1
    let prefix = ''
    let estimate = 0
    for (const chunk of chunks) {
      // Each code unit encodes to at least one byte, so `wanted` units cover the head of a huge chunk.
      const piece = chunk.length > wanted ? chunk.slice(0, wanted + 1) : chunk
      prefix += piece
      estimate += Buffer.byteLength(piece, 'utf8')
      if (estimate >= wanted) {
        estimate = Buffer.byteLength(prefix, 'utf8')
        if (estimate >= wanted) {
          break
        }
      }
    }
    return { head: utf8Head(prefix, headBytes), byteLength, digest, truncated: true }
  }
}

export function boundedDeltaPayload(
  chunks: readonly string[],
  digest: AgentSessionDeltaDigest | null,
  headBytes: number
): AgentJournalBoundedPayload {
  return digest
    ? digest.payload(chunks, headBytes)
    : boundPayload(chunks.join(''), { inlineHeadBytes: headBytes })
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}
