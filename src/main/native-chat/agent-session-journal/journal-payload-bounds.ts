// Payload bounds for tool output and diffs.
//
// A 40 MB tool result must not be inlined into a row that every reconnecting
// client replays. A bounded payload keeps a head plus the original byte length
// and digest, and the remainder goes to the session's overflow store BEFORE the
// clip — so the bound is what a client renders, never what survives on the host.
//
// The sink is part of `JournalPayloadLimits` rather than a default, because the
// question "where does the remainder go?" has to be answered at the call site.
// A bound applied to a derived identifier answers it with
// `UNRETAINED_JOURNAL_PAYLOAD_LIMITS`, which is a visible, reviewable choice.

import { createHash } from 'node:crypto'
import type { AgentJournalBoundedPayload } from '../../../shared/agent-session-journal-types'
import { JOURNAL_OVERFLOW_NOT_RETAINED, type JournalOverflowSink } from './journal-overflow-store'

export type JournalPayloadLimits = {
  /** Bytes of the payload kept inline on the row. */
  inlineHeadBytes: number
  /** Where the clipped remainder is retained. */
  overflow: JournalOverflowSink
}

export const DEFAULT_JOURNAL_INLINE_HEAD_BYTES = 16 * 1024

/** The row budget, retaining everything it clips into `overflow`. */
export function journalPayloadLimits(overflow: JournalOverflowSink): JournalPayloadLimits {
  return { inlineHeadBytes: DEFAULT_JOURNAL_INLINE_HEAD_BYTES, overflow }
}

/** For bounds whose clipped tail is a derived key fragment — a prompt option id,
 *  a turn ordinal map, an image reference — and not user data. */
export const UNRETAINED_JOURNAL_PAYLOAD_LIMITS: JournalPayloadLimits = {
  inlineHeadBytes: DEFAULT_JOURNAL_INLINE_HEAD_BYTES,
  overflow: JOURNAL_OVERFLOW_NOT_RETAINED
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

/** Clip `payload` to the inline head, retaining the whole of it under `digest`
 *  first. `spilled` says the retention succeeded; without it the row is exactly
 *  the head, length and digest it would have carried before. */
export function boundPayload(
  payload: string,
  limits: JournalPayloadLimits
): AgentJournalBoundedPayload {
  const buffer = Buffer.from(payload, 'utf8')
  const digest = digestPayload(payload)
  if (buffer.byteLength <= limits.inlineHeadBytes) {
    return { head: payload, byteLength: buffer.byteLength, digest, truncated: false }
  }
  // Retain BEFORE the clip: this is the last point that holds the whole payload.
  const spilled = limits.overflow.retain(digest, payload)
  return {
    head: clipUtf8(buffer, limits.inlineHeadBytes),
    byteLength: buffer.byteLength,
    digest,
    truncated: true,
    ...(spilled ? { spilled: true as const } : {})
  }
}

/** Bound a plain string that must stay a string (a tool-result block's output),
 *  keeping the explicit marker inline. */
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

/** Keep arbitrary tool input JSON bounded before it reaches a row. */
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
        head: bounded.head,
        ...(bounded.spilled ? { spilled: true as const } : {})
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
