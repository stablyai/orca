import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import type {
  AgentJournalBoundedPayload,
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { utf8Head } from './item-lifecycle/journal-payload-bounds'
import { AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES } from '../agent-session-wire/publication/history/agent-session-item-wire-form'

/** Off until every build in the supported downgrade window reads stored outputs. */
export const JOURNAL_STORED_OUTPUT_WRITES = false

// Format 1: zstd frames over JSON string literals (lone surrogates survive); frame A is the wire head.
const FORMAT_ZSTD_JSON_FRAMES = 1
const HEADER_BYTES = 5
const MIN_STORED_TEXT_BYTES = 512
const ZSTD_PARAMS = {
  [constants.ZSTD_c_compressionLevel]: 3,
  [constants.ZSTD_c_checksumFlag]: 1
}

type StoredMarker = { truncated: boolean }
type StoredPayload = AgentJournalBoundedPayload & { stored: StoredMarker }

/** `whole` restores the saved text; `wire` restores only the client head (at most one frame). */
export type JournalStoredOutputForm = 'whole' | 'wire'

function itemPayload(body: AgentJournalItemBody): AgentJournalBoundedPayload | undefined {
  if (body.kind === 'tool-call') {
    return body.state === 'running' ? undefined : body.output
  }
  return body.kind === 'diff' ? body.patch : undefined
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
  const body = item.body
  const payload =
    body.kind === 'tool-call' ? body.output : body.kind === 'diff' ? body.patch : undefined
  return storedMarker(payload) !== null
}

/** The row form and its blob, or null when this item's text stays inline. */
export function storeJournalItemOutput<T extends AgentJournalRenderItem>(
  item: T
): { item: T; blob: Buffer } | null {
  const payload = itemPayload(item.body)
  if (!payload || storedMarker(payload) || payload.head.length * 3 < MIN_STORED_TEXT_BYTES) {
    return null
  }
  const text = payload.head
  const textBytes = Buffer.byteLength(text, 'utf8')
  if (textBytes < MIN_STORED_TEXT_BYTES) {
    return null
  }
  const split =
    textBytes > AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES
      ? utf8Head(text, AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES).length
      : text.length
  const head = zstdCompressSync(Buffer.from(JSON.stringify(text.slice(0, split))), {
    params: ZSTD_PARAMS
  })
  const rest =
    split < text.length
      ? zstdCompressSync(Buffer.from(JSON.stringify(text.slice(split))), { params: ZSTD_PARAMS })
      : null
  const blobBytes = HEADER_BYTES + head.length + (rest?.length ?? 0)
  // Small or incompressible text costs more as a blob plus marker than inline.
  if (blobBytes > textBytes * 0.8) {
    return null
  }
  const blob = Buffer.allocUnsafe(blobBytes)
  blob.writeUInt8(FORMAT_ZSTD_JSON_FRAMES, 0)
  blob.writeUInt32BE(head.length, 1)
  head.copy(blob, HEADER_BYTES)
  rest?.copy(blob, HEADER_BYTES + head.length)
  const stored: StoredPayload = {
    head: '',
    byteLength: payload.byteLength,
    digest: payload.digest,
    truncated: true,
    stored: { truncated: payload.truncated }
  }
  return { item: withPayload(item, stored), blob }
}

function decodeFrame(frame: Uint8Array, maxBytes: number): string {
  const text: unknown = JSON.parse(
    zstdDecompressSync(frame, { maxOutputLength: maxBytes }).toString('utf8')
  )
  if (typeof text !== 'string') {
    throw new Error('stored output frame is not text')
  }
  return text
}

/** Unreadable blobs keep the marker, so a rewrite keeps the blob rather than an empty head. */
export function hydrateJournalItemOutput<T extends AgentJournalRenderItem>(
  item: T,
  blob: Uint8Array | null | undefined,
  form: JournalStoredOutputForm = 'whole'
): T {
  const body = item.body
  const payload =
    body.kind === 'tool-call' ? body.output : body.kind === 'diff' ? body.patch : undefined
  const marker = storedMarker(payload)
  if (!payload || !marker) {
    return item
  }
  try {
    if (!blob || blob.length < HEADER_BYTES || blob[0] !== FORMAT_ZSTD_JSON_FRAMES) {
      throw new Error('stored output blob is missing or unknown')
    }
    const view = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
    const headEnd = HEADER_BYTES + view.readUInt32BE(1)
    // JSON escapes spend at most six bytes per UTF-8 byte; the frame bound caps inflation.
    const maxBytes = payload.byteLength * 6 + 64
    const head = decodeFrame(view.subarray(HEADER_BYTES, headEnd), maxBytes)
    const more = headEnd < view.length
    if (form === 'wire') {
      return withPayload(item, {
        head: more ? utf8Head(head, AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES) : head,
        byteLength: payload.byteLength,
        digest: payload.digest,
        truncated: more || marker.truncated
      })
    }
    const text = more ? head + decodeFrame(view.subarray(headEnd), maxBytes) : head
    if (!marker.truncated && Buffer.byteLength(text, 'utf8') !== payload.byteLength) {
      throw new Error('stored output length does not match its item')
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
