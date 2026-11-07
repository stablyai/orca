import type { AgentJournalBoundedPayload } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { type AgentSessionDeltaDigest, boundedDeltaPayload } from './agent-session-delta-digest'

export type AgentSessionDeltaSnapshot = {
  /** Joins the retained chunks on first read. */
  readonly text: string
  readonly textLength: number
  observedBytes: number
  truncated: boolean
  /** Bounded preview of the text; reads only the head when the stream keeps a digest. */
  bounded: (headBytes: number) => AgentJournalBoundedPayload
}

export type AgentSessionDeltaStream = {
  chunks: string[]
  retainedBytes: number
  textLength: number
  observedBytes: number
  truncated: boolean
  dirty: boolean
  /** When the oldest unsaved delta arrived. */
  dirtyAt: number
  digest: AgentSessionDeltaDigest | null
}

/** Text stays as of this call; bounded() reads the stream as it is when called. */
export function snapshotOf(stream: AgentSessionDeltaStream): AgentSessionDeltaSnapshot {
  // Appends push in place; truncation swaps the array, so the captured count fixes the text.
  const { chunks } = stream
  const count = chunks.length
  let text: string | undefined
  const snapshot: AgentSessionDeltaSnapshot = {
    get text() {
      text ??= (count === chunks.length ? chunks : chunks.slice(0, count)).join('')
      return text
    },
    textLength: stream.textLength,
    observedBytes: stream.observedBytes,
    truncated: stream.truncated,
    bounded: (headBytes) => boundedDeltaPayload(stream.chunks, stream.digest, headBytes)
  }
  // Hidden, so snapshots still compare and serialize as text and byte counts.
  Object.defineProperty(snapshot, 'textLength', { enumerable: false })
  Object.defineProperty(snapshot, 'bounded', { enumerable: false })
  return snapshot
}
