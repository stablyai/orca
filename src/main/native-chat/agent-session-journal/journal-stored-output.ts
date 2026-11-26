import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import type {
  AgentJournalBoundedPayload,
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'

/** Off until builds that cannot read stored outputs are out of the downgrade window; reads always work. */
export const JOURNAL_STORED_OUTPUT_WRITES = false

// Format 1: one zstd frame over the text as a JSON string literal, so lone surrogates survive.
const FORMAT_ZSTD_JSON = 1
const MIN_STORED_TEXT_BYTES = 512
// Encoding and the read-back check run inside the writer transaction; larger text stays inline.
export const MAX_STORED_TEXT_BYTES = 2 * 1024 * 1024
// Builds that predate stored outputs show this inline preview, as does this one if a blob is unreadable.
const PREVIEW_HEAD_CHARS = 512
const PREVIEW_TAIL_CHARS = 512
const ZSTD_PARAMS = {
  [constants.ZSTD_c_compressionLevel]: 3,
  [constants.ZSTD_c_checksumFlag]: 1
}

type StoredMarker = { truncated: boolean }
type StoredPayload = AgentJournalBoundedPayload & { stored: StoredMarker }

function bodyPayload(body: AgentJournalItemBody): AgentJournalBoundedPayload | undefined {
  return body.kind === 'tool-call' ? body.output : body.kind === 'diff' ? body.patch : undefined
}

function withPayload<T extends AgentJournalRenderItem>(
  item: T,
  payload: AgentJournalBoundedPayload
): T {
  const body =
    item.body.kind === 'tool-call'
      ? { ...item.body, output: payload }
      : item.body.kind === 'diff'
        ? { ...item.body, patch: payload }
        : item.body
  return { ...item, body }
}

function storedMarker(payload: AgentJournalBoundedPayload | undefined): StoredMarker | null {
  const stored: unknown = payload && 'stored' in payload ? payload.stored : undefined
  return typeof stored === 'object' &&
    stored !== null &&
    'truncated' in stored &&
    typeof stored.truncated === 'boolean'
    ? { truncated: stored.truncated }
    : null
}

export function hasJournalStoredOutput(item: AgentJournalRenderItem): boolean {
  return storedMarker(bodyPayload(item.body)) !== null
}

/** The recorded length of the text an item stores outside its row, 0 when it stores none. */
export function journalStoredTextBytes(item: AgentJournalRenderItem): number {
  const payload = bodyPayload(item.body)
  return payload && storedMarker(payload) ? payload.byteLength : 0
}

/** The row form and its blob, or null when this item's text stays inline. */
export function storeJournalItemOutput<T extends AgentJournalRenderItem>(
  item: T
): { item: T; blob: Buffer } | null {
  const payload = bodyPayload(item.body)
  if (
    !payload ||
    (item.body.kind === 'tool-call' && item.body.state === 'running') ||
    storedMarker(payload) ||
    payload.head.length * 3 < MIN_STORED_TEXT_BYTES ||
    payload.head.length > MAX_STORED_TEXT_BYTES
  ) {
    return null
  }
  const textBytes = Buffer.byteLength(payload.head, 'utf8')
  // Reads bound and check decoding by the recorded length, so a text that disagrees stays inline.
  if (
    textBytes < MIN_STORED_TEXT_BYTES ||
    textBytes > MAX_STORED_TEXT_BYTES ||
    textBytes > payload.byteLength ||
    (!payload.truncated && textBytes !== payload.byteLength)
  ) {
    return null
  }
  const text = payload.head
  if (text.length <= PREVIEW_HEAD_CHARS + PREVIEW_TAIL_CHARS + MIN_STORED_TEXT_BYTES) {
    return null
  }
  const preview =
    PREVIEW_TAIL_CHARS > 0
      ? `${text.slice(0, PREVIEW_HEAD_CHARS)}\n…\n${text.slice(-PREVIEW_TAIL_CHARS)}`
      : text.slice(0, PREVIEW_HEAD_CHARS)
  const frame = zstdCompressSync(Buffer.from(JSON.stringify(text)), { params: ZSTD_PARAMS })
  // Small or incompressible text costs more as a blob plus preview than inline.
  if (frame.length + 1 + Buffer.byteLength(preview, 'utf8') > textBytes * 0.8) {
    return null
  }
  const blob = Buffer.allocUnsafe(frame.length + 1)
  blob.writeUInt8(FORMAT_ZSTD_JSON, 0)
  frame.copy(blob, 1)
  const stored: StoredPayload = {
    head: preview,
    byteLength: payload.byteLength,
    digest: payload.digest,
    truncated: true,
    stored: { truncated: payload.truncated }
  }
  return { item: withPayload(item, stored), blob }
}

/** The inline preview as a plain truncated payload, for a stored form whose row holds no blob. */
export function journalItemOutputPreview<T extends AgentJournalRenderItem>(item: T): T {
  const payload = bodyPayload(item.body)
  if (!payload || !storedMarker(payload)) {
    return item
  }
  const { head, byteLength, digest } = payload
  return withPayload(item, { head, byteLength, digest, truncated: true })
}

/** Unreadable blobs keep the marker, so a rewrite keeps the blob rather than an empty head. */
export function hydrateJournalItemOutput<T extends AgentJournalRenderItem>(
  item: T,
  blob: Uint8Array | null | undefined
): T {
  const payload = bodyPayload(item.body)
  const marker = storedMarker(payload)
  if (!payload || !marker) {
    return item
  }
  try {
    if (!blob || blob.length < 2 || blob[0] !== FORMAT_ZSTD_JSON) {
      throw new Error('stored output blob is missing or unknown')
    }
    // JSON escapes spend at most six bytes per UTF-8 byte; the bound caps inflation.
    const json = zstdDecompressSync(blob.subarray(1), {
      maxOutputLength: payload.byteLength * 6 + 64
    })
    const text: unknown = JSON.parse(json.toString('utf8'))
    if (
      typeof text !== 'string' ||
      (!marker.truncated && Buffer.byteLength(text, 'utf8') !== payload.byteLength)
    ) {
      throw new Error('stored output does not match its item')
    }
    return withPayload(item, {
      head: text,
      byteLength: payload.byteLength,
      digest: payload.digest,
      truncated: marker.truncated
    })
  } catch (error) {
    console.warn('[agent-session-journal] a saved tool output could not be read', error)
    return item
  }
}
