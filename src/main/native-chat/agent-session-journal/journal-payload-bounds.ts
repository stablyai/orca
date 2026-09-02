// Payload bounds for tool output and diffs.
//
// A looping agent must not be able to fill the host disk, and a 40 MB tool
// result must not be inlined into a row that every reconnecting client
// replays. A bounded payload keeps a head plus the original byte length and
// digest; the remainder lives in the content-addressed blob store under the
// same retention as its epoch. Crossing a bound is always marked — never a
// silent drop.

import { createHash } from 'node:crypto'
import type { AgentJournalBoundedPayload } from '../../../shared/agent-session-journal-types'

export type JournalPayloadLimits = {
  /** Bytes of the payload kept inline on the row. */
  inlineHeadBytes: number
  /** Total bytes of journal rows one session may hold before appends are refused. */
  maxSessionBytes: number
  /** Appends allowed inside `appendWindowMs`, bounding a runaway agent's rate. */
  maxAppendsPerWindow: number
  appendWindowMs: number
}

export const DEFAULT_JOURNAL_PAYLOAD_LIMITS: JournalPayloadLimits = {
  inlineHeadBytes: 16 * 1024,
  maxSessionBytes: 256 * 1024 * 1024,
  maxAppendsPerWindow: 5000,
  appendWindowMs: 60_000
}

/** Marker appended to a clipped inline string so the UI never presents a
 *  truncated body as complete. Kept in the text itself because block-level
 *  payloads (tool-result output) have nowhere else to carry the flag. */
export function journalTruncationMarker(byteLength: number, digest: string): string {
  return `\n[Orca: output truncated — ${byteLength} bytes total, digest ${digest.slice(0, 12)}]`
}

export function digestPayload(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/**
 * Clip `payload` to the inline head. `truncated` means the remainder must be
 * written to the blob store under `digest` before the row is appended.
 */
export function boundPayload(
  payload: string,
  limits: JournalPayloadLimits
): AgentJournalBoundedPayload {
  const buffer = Buffer.from(payload, 'utf8')
  const digest = digestPayload(payload)
  if (buffer.byteLength <= limits.inlineHeadBytes) {
    return { head: payload, byteLength: buffer.byteLength, digest, truncated: false }
  }
  return {
    head: clipUtf8(buffer, limits.inlineHeadBytes),
    byteLength: buffer.byteLength,
    digest,
    truncated: true
  }
}

/** Bound a plain string that must stay a string (a tool-result block's output),
 *  keeping the explicit marker inline. Returns the blob payload to persist. */
export function boundInlineText(
  payload: string,
  limits: JournalPayloadLimits
): { text: string; bounded: AgentJournalBoundedPayload } {
  const bounded = boundPayload(payload, limits)
  if (!bounded.truncated) {
    return { text: payload, bounded }
  }
  return {
    text: bounded.head + journalTruncationMarker(bounded.byteLength, bounded.digest),
    bounded
  }
}

/** Keep arbitrary tool input JSON bounded before lifecycle admission. */
export function boundToolInput(input: unknown, limits: JournalPayloadLimits): unknown {
  let encoded: string
  try {
    encoded = JSON.stringify(input) ?? 'null'
  } catch {
    return {
      truncated: true,
      byteLength: 0,
      digest: digestPayload(''),
      head: '[unserializable input]'
    }
  }
  const bounded = boundPayload(encoded, limits)
  return bounded.truncated
    ? {
        truncated: true,
        byteLength: bounded.byteLength,
        digest: bounded.digest,
        head: bounded.head
      }
    : input
}

/** Slice at a byte budget without splitting a multi-byte character. */
function clipUtf8(buffer: Buffer, maxBytes: number): string {
  let end = maxBytes
  // A UTF-8 continuation byte is 0b10xxxxxx; walk back off a split sequence.
  while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1
  }
  return buffer.subarray(0, end).toString('utf8')
}
