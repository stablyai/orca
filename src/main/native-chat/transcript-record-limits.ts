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
// what it holds. Once complete, a line over the plain limit is kept only if it embeds inline
// base64 (Claude `source.type: "base64"` or a `data:...;base64,` URI); other oversized text is dropped.
export function exceedsPlainTranscriptRecordLimit(record: Buffer): boolean {
  return (
    record.length > MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES &&
    !record.includes('"base64"') &&
    !record.includes(';base64,')
  )
}
