import { z } from 'zod'
import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../../../src/shared/clipboard-image'
import { MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from '../../session/mobile-clipboard-image-upload-chunk'

// Picked media exceeds frame/reply ceilings, especially after base64; stage behind a handle and read chunks before release.
// Keep grant segments lowercase: media.readChunk would fail manifest grammar and reject the whole bundle.

// Clipboard images use the same pick/stage/read path; keep clipboard.read text-only rather than returning oversized inline images.
export const BRIDGE_MEDIA_SOURCES = ['library', 'files', 'clipboard'] as const

export type BridgeMediaSource = (typeof BRIDGE_MEDIA_SOURCES)[number]

export const BRIDGE_MEDIA_HANDLE_MAX_CHARS = 64

export const BRIDGE_MEDIA_MIME_MAX_CHARS = 128

// Every handle owns a cached copy; cap total staged media at 144 MiB on phones. Refuse overflowing multi-selects whole rather than silently returning half.
export const BRIDGE_MEDIA_MAX_LIVE_HANDLES = 8

// Derive read bytes from upload base64 chunk size using complete four-character/three-byte groups so the bounds cannot drift.
export const BRIDGE_MEDIA_READ_MAX_BYTES =
  Math.floor(MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS / 4) * 3

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

const handleSchema = z.string().min(1).max(BRIDGE_MEDIA_HANDLE_MAX_CHARS)

const byteOffsetSchema = z.number().int().min(0).max(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES)

// Dimensions are optional because document pickers may report files without raster metadata; only pre-read preview sizing uses them.
export const mediaItemSchema = z.strictObject({
  handle: handleSchema,
  mime: z.string().max(BRIDGE_MEDIA_MIME_MAX_CHARS).regex(MIME_PATTERN),
  byteLength: byteOffsetSchema,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional()
})

export type BridgeMediaItem = z.infer<typeof mediaItemSchema>

// Reject extra params so independently updated page/shell builds cannot silently strip a meaningful request field.
export const mediaPickParamsSchema = z.strictObject({
  source: z.enum(BRIDGE_MEDIA_SOURCES),
  multiple: z.boolean()
})

export const mediaPickResultSchema = z.strictObject({
  items: z.array(mediaItemSchema).max(BRIDGE_MEDIA_MAX_LIVE_HANDLES)
})

export const mediaReadParamsSchema = z.strictObject({
  handle: handleSchema,
  offset: byteOffsetSchema,
  length: z.number().int().min(1).max(BRIDGE_MEDIA_READ_MAX_BYTES)
})

// Use explicit eof: short reads cannot distinguish a chunk cap from file end, especially at exact cap multiples.
export const mediaReadResultSchema = z.strictObject({
  base64: z.string().max(MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS).regex(BASE64_PATTERN),
  eof: z.boolean()
})

export type BridgeMediaChunk = z.infer<typeof mediaReadResultSchema>

// Releasing an already released/expired handle is a normal false, not a fault.
export const mediaReleaseParamsSchema = z.strictObject({ handle: handleSchema })

export const mediaReleaseResultSchema = z.strictObject({ released: z.boolean() })

export const BRIDGE_MEDIA_NAME_MAX_CHARS = 255

// Use an optional name verb: adding a field to strict mediaItemSchema would break old pages. Without the grant, pages derive names from mime.
export const mediaNameParamsSchema = z.strictObject({ handle: handleSchema })

export const mediaNameResultSchema = z.strictObject({
  name: z.string().min(1).max(BRIDGE_MEDIA_NAME_MAX_CHARS).nullable()
})
