import type { NativeChatMessage } from '../../shared/native-chat/native-chat-types'

// Largest decoded screenshot the cache accepts. Bounds transient decoding and disk use.
export const NATIVE_CHAT_IMAGE_CACHE_MAX_BYTES = 8 * 1024 * 1024

// Why: records without images keep the original 2 MiB guard (worker transcript reads still use it).
export const MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES = 2 * 1024 * 1024

// Why: a cacheable screenshot is stored inline as base64 (4 bytes per 3) inside one JSONL record,
// so the readers must accept a record at least that large or the cache limit is unreachable.
const BASE64_INLINE_IMAGE_BYTES = Math.ceil(NATIVE_CHAT_IMAGE_CACHE_MAX_BYTES / 3) * 4
const JSONL_ENVELOPE_ALLOWANCE_BYTES = 256 * 1024
export const MAX_NATIVE_CHAT_IMAGE_TRANSCRIPT_RECORD_BYTES =
  BASE64_INLINE_IMAGE_BYTES + JSONL_ENVELOPE_ALLOWANCE_BYTES

// Why: readers retain up to the image-aware limit while a line streams in, before they can know
// what it holds. The cheap marker check below only skips decoding for obvious plain text; the
// decoded message is then checked structurally by `exceedsPlainBudgetAfterDecode`.
export function exceedsPlainTranscriptRecordLimit(record: Buffer): boolean {
  return (
    record.length > MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES &&
    !record.includes('"base64"') &&
    !record.includes(';base64,')
  )
}

// Inline data-URI bytes that decoding actually accepted as raster image blocks.
export function inlineImageBytes(message: NativeChatMessage): number {
  let total = 0
  for (const block of message.blocks) {
    if (block.type === 'image-ref' && block.url?.startsWith('data:')) {
      total += block.url.length
    }
  }
  return total
}

// A record over the plain limit may only be large because of validated image payloads; the rest
// (text, tool output) must still fit the plain limit.
export function exceedsPlainBudgetAfterDecode(
  recordBytes: number,
  message: NativeChatMessage
): boolean {
  return recordBytes - inlineImageBytes(message) > MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES
}

// Why: the per-record limit is ~11 MiB, so without an aggregate cap `limit` records (or a long
// append) could hold hundreds of MiB of data URIs before the RPC layer swaps them for cache refs.
export const MAX_NATIVE_CHAT_INLINE_IMAGE_READ_BYTES = 32 * 1024 * 1024
