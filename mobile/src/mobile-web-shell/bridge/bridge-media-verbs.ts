import { z } from 'zod'
import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../../../src/shared/clipboard-image'
import { MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from '../../session/mobile-clipboard-image-upload-chunk'

/**
 * The wire shapes of `native.media.pick`, `native.media.read` and `native.media.release`.
 *
 * A picked image is up to `CLIPBOARD_IMAGE_MAX_SOURCE_BYTES` of raw bytes: twenty-eight times the
 * frame cap, and two and a quarter times the reply ceiling before anything encodes it. Base64 is
 * what makes that three times the ceiling, which is a different basis and is why both are named.
 * Either way the value never crosses as a value. `pick` answers a handle the shell owns, `read`
 * moves the bytes a chunk at a time, and `release` ends it. Split from `bridge-native-verbs.ts`
 * because these three are one contract of their own and that module is the table every verb is
 * listed in.
 *
 * The verb is `read` and not `readChunk` for a reason a rename cannot be undone from: a manifest
 * grant name is held to `native(?:\.[a-z][a-z0-9]*){2,}`, and `bundled-mobile-web-bundle.ts`
 * parses the manifest whole, so one camel-cased segment is not a route that falls back to native —
 * it is a bundle the phone refuses entire.
 */

/**
 * Where the bytes come from. `clipboard` is a source here rather than a fourth verb, which is what
 * lets `native.clipboard.read` stay a text verb: an image on the pasteboard is picked, staged and
 * read in chunks like any other, instead of being widened into an inline value the caps refuse.
 */
export const BRIDGE_MEDIA_SOURCES = ['library', 'files', 'clipboard'] as const

export type BridgeMediaSource = (typeof BRIDGE_MEDIA_SOURCES)[number]

/** An opaque name the shell mints. Bounded because the page echoes it back on every chunk. */
export const BRIDGE_MEDIA_HANDLE_MAX_CHARS = 64

/** `type/subtype`, as a picker reports it. Bounded, and long enough for the parameters one
 *  carries. */
export const BRIDGE_MEDIA_MIME_MAX_CHARS = 128

/**
 * Handles one page session may hold at once, which is also the most items one pick may answer.
 *
 * Each live handle is a staged copy in the cache directory of up to
 * `CLIPBOARD_IMAGE_MAX_SOURCE_BYTES`, so this many is the 144 MiB ceiling the shell may be holding
 * on a phone before the OS starts reclaiming underneath it. A pick that would pass it is refused
 * whole rather than truncated: half a multi-select is a worse answer than none.
 */
export const BRIDGE_MEDIA_MAX_LIVE_HANDLES = 8

/**
 * The bytes one `read` may ask for, derived from the chunk the upload path already sends.
 *
 * Whole base64 groups of `MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS`: four characters encode
 * three bytes, so a read of this many bytes is exactly that many characters and never one more.
 * Derived rather than written down beside it, because two numbers that must agree are one that
 * drifts.
 */
export const BRIDGE_MEDIA_READ_MAX_BYTES =
  Math.floor(MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS / 4) * 3

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

const handleSchema = z.string().min(1).max(BRIDGE_MEDIA_HANDLE_MAX_CHARS)

/** A byte offset into a staged file: whole, never negative, never past what one may hold. */
const byteOffsetSchema = z.number().int().min(0).max(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES)

/**
 * One picked item, as the page reads it.
 *
 * `width` and `height` are optional because a picker does not always report them — a document
 * picker hands back a file, not a raster — and a page that wants to size a preview before it has
 * read a byte is the only reader of either.
 */
export const mediaItemSchema = z.strictObject({
  handle: handleSchema,
  mime: z.string().max(BRIDGE_MEDIA_MIME_MAX_CHARS).regex(MIME_PATTERN),
  byteLength: byteOffsetSchema,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional()
})

export type BridgeMediaItem = z.infer<typeof mediaItemSchema>

// Strict, not stripping, for the reason the clipboard verbs are: the page and the shell are
// separate builds, and a param the shell silently drops is the shape of a verb that changed.
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

/**
 * `eof` rather than a short read, because a short read is ambiguous: a page cannot tell a file that
 * ended from a chunk cap it hit, and a reader that guesses stops one chunk early on exactly the
 * files whose length is a multiple of the cap.
 */
export const mediaReadResultSchema = z.strictObject({
  base64: z.string().max(MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS).regex(BASE64_PATTERN),
  eof: z.boolean()
})

export type BridgeMediaChunk = z.infer<typeof mediaReadResultSchema>

/** False for a handle this session no longer holds, which is not a fault: a page that releases
 *  twice, or releases after the TTL swept, asked for the state it already has. */
export const mediaReleaseParamsSchema = z.strictObject({ handle: handleSchema })

export const mediaReleaseResultSchema = z.strictObject({ released: z.boolean() })
