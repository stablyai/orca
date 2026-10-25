import { createHash } from 'node:crypto'
import type { AgentJournalBoundedPayload } from '../../../shared/agent-session-journal-types'

export type JournalPayloadLimits = {
  inlineHeadBytes: number
}

// Running revisions retain previews; completed content remains whole.
export const JOURNAL_RUNNING_PREVIEW_LIMITS: JournalPayloadLimits = {
  inlineHeadBytes: 16 * 1024
}

// Unmodeled provider traffic keeps bounded disclosure, not canonical conversation content.
export const PROVIDER_FRAME_PAYLOAD_LIMITS: JournalPayloadLimits = { inlineHeadBytes: 16 * 1024 }

// Provider errors are untrusted bulk attached to every submission listing (#20654).
export const JOURNAL_DISPATCH_REASON_LIMITS: JournalPayloadLimits = { inlineHeadBytes: 16 * 1024 }

/** Inline markers prevent plain-string blocks from presenting clipped content as complete. */
export function journalTruncationMarker(byteLength: number, digest: string): string {
  return `\n[Orca: output truncated — ${byteLength} bytes total, digest ${digest.slice(0, 12)}]`
}

export function digestPayload(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export function journalPayload(payload: string): AgentJournalBoundedPayload {
  return {
    head: payload,
    byteLength: Buffer.byteLength(payload, 'utf8'),
    digest: digestPayload(payload),
    truncated: false
  }
}

export function journalToolPayload(payload: string, running: boolean): AgentJournalBoundedPayload {
  return running ? boundPayload(payload, JOURNAL_RUNNING_PREVIEW_LIMITS) : journalPayload(payload)
}

/** Digest/byteLength describe the original, even when only its head is retained. */
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

/** Encode only the bounded head without splitting UTF-8 characters. */
export function utf8Head(text: string, maxBytes: number): string {
  const boundedBuffer =
    Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? Buffer.allocUnsafe(maxBytes) : null
  return boundedBuffer
    ? boundedBuffer.toString('utf8', 0, boundedBuffer.write(text, 0, boundedBuffer.length, 'utf8'))
    : clipUtf8(Buffer.from(text, 'utf8'), maxBytes)
}

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

function clipUtf8(buffer: Buffer, maxBytes: number): string {
  let end = maxBytes
  // Backtrack over continuation bytes to avoid splitting a UTF-8 code point.
  while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1
  }
  return buffer.subarray(0, end).toString('utf8')
}
