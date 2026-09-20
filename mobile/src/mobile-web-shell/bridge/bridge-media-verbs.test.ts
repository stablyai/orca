/** The three media verbs' wire shapes: what a page may ask for, and what a handler may answer. */
import { describe, expect, it } from 'vitest'
import { MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from '../../session/mobile-clipboard-image-upload-chunk'
import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../../../src/shared/clipboard-image'
import {
  BRIDGE_MEDIA_HANDLE_MAX_CHARS,
  BRIDGE_MEDIA_MAX_LIVE_HANDLES,
  BRIDGE_MEDIA_MIME_MAX_CHARS,
  BRIDGE_MEDIA_READ_MAX_BYTES,
  BRIDGE_MEDIA_SOURCES,
  mediaPickParamsSchema,
  mediaPickResultSchema,
  mediaReadParamsSchema,
  mediaReadResultSchema,
  mediaReleaseParamsSchema,
  mediaReleaseResultSchema
} from './bridge-media-verbs'

const HANDLE = 'media-1'

describe('the numbers this contract states', () => {
  /**
   * Literals, not the constants restated: every one of these is a number a body claims and a
   * reviewer checked, and read through its own name the assertion would hold whatever it became.
   * The derived one is pinned by its derivation above, which is the other half of the same rule.
   */
  it('holds a page session to eight staged items, which is 144 MiB of cache', () => {
    expect(BRIDGE_MEDIA_MAX_LIVE_HANDLES).toBe(8)
    expect(BRIDGE_MEDIA_MAX_LIVE_HANDLES * CLIPBOARD_IMAGE_MAX_SOURCE_BYTES).toBe(150_994_944)
  })

  it('holds a handle to 64 characters and a mime to 128', () => {
    expect(BRIDGE_MEDIA_HANDLE_MAX_CHARS).toBe(64)
    expect(BRIDGE_MEDIA_MIME_MAX_CHARS).toBe(128)
  })

  it('reads a whole item in 48 chunks at the cap, which is what a device proof counts', () => {
    expect(BRIDGE_MEDIA_READ_MAX_BYTES).toBe(393_216)
    expect(Math.ceil(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES / BRIDGE_MEDIA_READ_MAX_BYTES)).toBe(48)
  })
})

describe('what a pick may ask for', () => {
  it('takes each source the shell serves, single or multiple', () => {
    for (const source of BRIDGE_MEDIA_SOURCES) {
      for (const multiple of [true, false]) {
        expect(mediaPickParamsSchema.safeParse({ source, multiple }).success, source).toBe(true)
      }
    }
  })

  it('refuses a source this build has no picker for, and a missing or extra key', () => {
    for (const params of [
      { source: 'camera', multiple: false },
      { source: 'library' },
      { multiple: true },
      { source: 'library', multiple: 'yes' },
      { source: 'library', multiple: false, limit: 3 }
    ]) {
      expect(mediaPickParamsSchema.safeParse(params).success, JSON.stringify(params)).toBe(false)
    }
  })
})

describe('what a pick may answer', () => {
  const item = { handle: HANDLE, mime: 'image/png', byteLength: 1024 }

  it('takes items with and without their pixel dimensions', () => {
    expect(mediaPickResultSchema.safeParse({ items: [item] }).success).toBe(true)
    expect(
      mediaPickResultSchema.safeParse({ items: [{ ...item, width: 4, height: 3 }] }).success
    ).toBe(true)
    expect(mediaPickResultSchema.safeParse({ items: [] }).success).toBe(true)
  })

  it('holds a handler to the live-handle cap, so one pick cannot outrun the registry', () => {
    const many = (count: number): unknown => ({
      items: Array.from({ length: count }, () => item)
    })
    expect(mediaPickResultSchema.safeParse(many(BRIDGE_MEDIA_MAX_LIVE_HANDLES)).success).toBe(true)
    expect(mediaPickResultSchema.safeParse(many(BRIDGE_MEDIA_MAX_LIVE_HANDLES + 1)).success).toBe(
      false
    )
  })

  it('refuses an item the page could not act on', () => {
    for (const bad of [
      { ...item, handle: '' },
      { ...item, handle: 'h'.repeat(BRIDGE_MEDIA_HANDLE_MAX_CHARS + 1) },
      { ...item, mime: 'image' },
      { ...item, mime: 'data:image/png;base64,AAAA' },
      { ...item, byteLength: -1 },
      { ...item, byteLength: 1.5 },
      { ...item, byteLength: CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1 },
      { ...item, width: 0 },
      { ...item, height: -2 }
    ]) {
      expect(mediaPickResultSchema.safeParse({ items: [bad] }).success, JSON.stringify(bad)).toBe(
        false
      )
    }
  })
})

describe('what a chunk read may ask for', () => {
  it('derives its byte length from the upload path, never from a second number', () => {
    // Whole base64 groups of the chunk the upload path already sends: four characters per three
    // bytes, so a read of this many bytes encodes to exactly the char budget and never past it.
    expect(BRIDGE_MEDIA_READ_MAX_BYTES).toBe(
      Math.floor(MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS / 4) * 3
    )
  })

  it('takes a read at the cap and refuses one past it', () => {
    const at = { handle: HANDLE, offset: 0, length: BRIDGE_MEDIA_READ_MAX_BYTES }
    expect(mediaReadParamsSchema.safeParse(at).success).toBe(true)
    expect(mediaReadParamsSchema.safeParse({ ...at, length: at.length + 1 }).success).toBe(false)
  })

  it('refuses a read that names nothing a file has', () => {
    for (const params of [
      { handle: HANDLE, offset: 0, length: 0 },
      { handle: HANDLE, offset: -1, length: 16 },
      { handle: HANDLE, offset: 1.5, length: 16 },
      { handle: HANDLE, offset: CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1, length: 16 },
      { handle: '', offset: 0, length: 16 },
      { handle: HANDLE, offset: 0 },
      { handle: HANDLE, offset: 0, length: 16, encoding: 'hex' }
    ]) {
      expect(mediaReadParamsSchema.safeParse(params).success, JSON.stringify(params)).toBe(false)
    }
  })

  it('holds the answer to the base64 the chunk cap allows', () => {
    const base64 = 'a'.repeat(MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS)
    expect(mediaReadResultSchema.safeParse({ base64, eof: false }).success).toBe(true)
    expect(mediaReadResultSchema.safeParse({ base64: `${base64}a`, eof: true }).success).toBe(false)
    expect(mediaReadResultSchema.safeParse({ base64: '', eof: true }).success).toBe(true)
    expect(mediaReadResultSchema.safeParse({ base64: '!!', eof: true }).success).toBe(false)
  })
})

describe('what a release may ask for and answer', () => {
  it('names one handle and says whether it held one', () => {
    expect(mediaReleaseParamsSchema.safeParse({ handle: HANDLE }).success).toBe(true)
    expect(mediaReleaseParamsSchema.safeParse({ handle: HANDLE, all: true }).success).toBe(false)
    expect(mediaReleaseResultSchema.safeParse({ released: false }).success).toBe(true)
    expect(mediaReleaseResultSchema.safeParse({ released: 'no' }).success).toBe(false)
  })
})
