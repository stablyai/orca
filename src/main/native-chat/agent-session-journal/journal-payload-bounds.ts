// Completed content is canonical; running revisions keep previews until the full close.
import { createHash } from 'node:crypto'
import type { AgentJournalBoundedPayload } from '../../../shared/agent-session-journal-types'

export type JournalPayloadLimits = {
  /** Bytes of the payload kept in `head`. */
  inlineHeadBytes: number
}

/** What a revision of a call still running keeps where every update is a row and the open budget
 *  holds it (provider-timeline-budget.ts); its closing revision keeps the whole value. */
export const JOURNAL_RUNNING_PREVIEW_LIMITS: JournalPayloadLimits = {
  inlineHeadBytes: 16 * 1024
}

/** The raw provider frame a row keeps behind its disclosure: a record of traffic Orca cannot
 *  model, not content the agent said, so it keeps a head. */
export const PROVIDER_FRAME_PAYLOAD_LIMITS: JournalPayloadLimits = { inlineHeadBytes: 16 * 1024 }

/** A send's rejection reason: a provider error body of any size, not conversation content, and
 *  it rides the submission list rather than an item (#20654). */
export const JOURNAL_DISPATCH_REASON_LIMITS: JournalPayloadLimits = { inlineHeadBytes: 16 * 1024 }

/** Marker appended to a clipped inline string so the UI never presents a
 *  truncated body as complete. Kept in the text itself because block-level
 *  payloads (tool-result output) have nowhere else to carry the flag. */
export function journalTruncationMarker(byteLength: number, digest: string): string {
  return `\n[Orca: output truncated — ${byteLength} bytes total, digest ${digest.slice(0, 12)}]`
}

export function digestPayload(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/** The whole value, as a tool output or diff is saved. */
export function journalPayload(payload: string): AgentJournalBoundedPayload {
  return {
    head: payload,
    byteLength: Buffer.byteLength(payload, 'utf8'),
    digest: digestPayload(payload),
    truncated: false
  }
}

/** Whole once `running` is false; a preview while the call still runs. */
export function journalToolPayload(payload: string, running: boolean): AgentJournalBoundedPayload {
  return running ? boundPayload(payload, JOURNAL_RUNNING_PREVIEW_LIMITS) : journalPayload(payload)
}

/** Clip `payload` to the inline head. `truncated` means the head is not the whole value;
 *  `digest` and `byteLength` describe the original. */
export function boundPayload(
  payload: string,
  limits: JournalPayloadLimits
): AgentJournalBoundedPayload {
  const byteLength = Buffer.byteLength(payload, 'utf8')
  const digest = digestPayload(payload)
  if (byteLength <= limits.inlineHeadBytes) {
    return { head: payload, byteLength, digest, truncated: false }
  }
  return { head: utf8Head(payload, limits.inlineHeadBytes), byteLength, digest, truncated: true }
}

/** The first `maxBytes` of `text` as UTF-8, never splitting a character; encodes only that head. */
export function utf8Head(text: string, maxBytes: number): string {
  const boundedBuffer =
    Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? Buffer.allocUnsafe(maxBytes) : null
  return boundedBuffer
    ? boundedBuffer.toString('utf8', 0, boundedBuffer.write(text, 0, boundedBuffer.length, 'utf8'))
    : clipUtf8(Buffer.from(text, 'utf8'), maxBytes)
}

/** Bound a plain string that must stay a string, keeping the explicit marker inline. */
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

/** Tool input JSON over the limit, as its head and the original's size and digest. */
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
