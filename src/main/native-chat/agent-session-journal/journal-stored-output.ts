import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import type {
  AgentJournalBoundedPayload,
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'

/** Off until every build in the supported downgrade window reads stored outputs. */
export const JOURNAL_STORED_OUTPUT_WRITES = false

// Format 1: one zstd frame over the text as a JSON string literal, so lone surrogates survive.
const FORMAT_ZSTD_JSON = 1
const MIN_STORED_TEXT_BYTES = 512
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
  const stored = (payload as Partial<StoredPayload> | undefined)?.stored
  return stored && typeof stored === 'object' && typeof stored.truncated === 'boolean'
    ? stored
    : null
}

export function hasJournalStoredOutput(item: AgentJournalRenderItem): boolean {
  return storedMarker(bodyPayload(item.body)) !== null
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
    payload.head.length * 3 < MIN_STORED_TEXT_BYTES
  ) {
    return null
  }
  const textBytes = Buffer.byteLength(payload.head, 'utf8')
  // A whole value whose recorded length disagrees could never be proven on read; keep it inline.
  if (
    textBytes < MIN_STORED_TEXT_BYTES ||
    (!payload.truncated && textBytes !== payload.byteLength)
  ) {
    return null
  }
  const frame = zstdCompressSync(Buffer.from(JSON.stringify(payload.head)), { params: ZSTD_PARAMS })
  // Small or incompressible text costs more as a blob plus marker than inline.
  if (frame.length + 1 > textBytes * 0.8) {
    return null
  }
  const blob = Buffer.allocUnsafe(frame.length + 1)
  blob.writeUInt8(FORMAT_ZSTD_JSON, 0)
  frame.copy(blob, 1)
  const stored: StoredPayload = {
    head: '',
    byteLength: payload.byteLength,
    digest: payload.digest,
    truncated: true,
    stored: { truncated: payload.truncated }
  }
  return { item: withPayload(item, stored), blob }
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
