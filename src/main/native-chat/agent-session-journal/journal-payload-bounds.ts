// Payload bounds for tool output and diffs.
//
// A 40 MB tool result must not be inlined into a row that every reconnecting
// client replays. A bounded payload keeps a head plus the original byte length
// and digest; the remainder is discarded. Crossing a bound is always marked —
// never a silent drop.

import { createHash } from 'node:crypto'
import type { AgentJournalBoundedPayload } from '../../../shared/agent-session-journal-types'
import {
  getDefaultJournalPayloadRetention,
  type JournalPayloadRetention
} from './journal-payload-store'

export type JournalPayloadLimits = {
  /** Bytes of the payload kept inline on the row. */
  inlineHeadBytes: number
}

export const DEFAULT_JOURNAL_PAYLOAD_LIMITS: JournalPayloadLimits = {
  inlineHeadBytes: 16 * 1024
}

/** Pass as `retention` when only the clipped string is kept and the bounded
 *  object is thrown away. Nothing then mints a reference to the original, so
 *  retaining it would leave bytes on disk that no reader is ever allowed to
 *  serve — see journal-payload-reference for which positions grant ownership. */
export const NO_PAYLOAD_RETENTION = null

/** Marker appended to a clipped inline string so the UI never presents a
 *  truncated body as complete. Kept in the text itself because block-level
 *  payloads (tool-result output) have nowhere else to carry the flag. */
export function journalTruncationMarker(byteLength: number, digest: string): string {
  return `\n[Orca: output truncated — ${byteLength} bytes total, digest ${digest.slice(0, 12)}]`
}

/** The sha256 that addresses a payload in the store and identifies it on a row. */
export function digestPayload(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/** Clip `payload` to the inline head. `truncated` means the row carries only
 *  the head; `digest` and `byteLength` describe the original. When a
 *  retention store is available (explicit `retention` or the installed
 *  default), the complete original is retained under `digest` and the row says
 *  so with `retrievable: true`; otherwise `retrievable: false` records that
 *  the remainder was discarded. Neither case is ever silent. */
export function boundPayload(
  payload: string,
  limits: JournalPayloadLimits,
  retention: JournalPayloadRetention | null = getDefaultJournalPayloadRetention()
): AgentJournalBoundedPayload {
  const buffer = Buffer.from(payload, 'utf8')
  const digest = digestPayload(payload)
  if (buffer.byteLength <= limits.inlineHeadBytes) {
    return { head: payload, byteLength: buffer.byteLength, digest, truncated: false }
  }
  let retrievable = false
  if (retention !== null) {
    try {
      retrievable = retention.retain(digest, payload) === true
    } catch {
      retrievable = false
    }
  }
  return {
    head: clipUtf8(buffer, limits.inlineHeadBytes),
    byteLength: buffer.byteLength,
    digest,
    truncated: true,
    retrievable
  }
}

/** Bound a plain string that must stay a string (a tool-result block's output),
 *  keeping the explicit marker inline. */
export function boundInlineText(
  payload: string,
  limits: JournalPayloadLimits,
  retention: JournalPayloadRetention | null = getDefaultJournalPayloadRetention()
): { text: string; bounded: AgentJournalBoundedPayload } {
  const bounded = boundPayload(payload, limits, retention)
  if (!bounded.truncated) {
    return { text: payload, bounded }
  }
  return {
    text: bounded.head + journalTruncationMarker(bounded.byteLength, bounded.digest),
    bounded
  }
}

/**
 * Keep arbitrary tool input JSON bounded before it reaches a row.
 *
 * Deliberately never retained: `input` is model-authored, so
 * journal-payload-reference refuses to read ownership out of it, and a row that
 * claimed `retrievable: true` here would advertise a read every host will
 * refuse while leaving unreachable bytes in the store. Clipping stays lossy.
 */
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
  const bounded = boundPayload(encoded, limits, NO_PAYLOAD_RETENTION)
  return bounded.truncated
    ? {
        truncated: true,
        byteLength: bounded.byteLength,
        digest: bounded.digest,
        head: bounded.head,
        retrievable: false
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
