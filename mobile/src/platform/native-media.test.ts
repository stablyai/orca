/** The device half of the media verbs: the picker it runs, the bytes it moves, the file it deletes. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { splitBridgeReply } from '../mobile-web-shell/bridge/bridge-reply-chunking'
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_REPLY_BYTES,
  utf8ByteLength
} from '../mobile-web-shell/bridge/bridge-caps'
import {
  BRIDGE_MEDIA_READ_CHUNK_MAX_BYTES,
  mediaPickResultSchema,
  mediaReadChunkResultSchema
} from '../mobile-web-shell/bridge/bridge-media-verbs'
import { readShellRefusalCode } from '../mobile-web-shell/bridge-host-errors'
import { MediaHandleRegistry } from '../mobile-web-shell/media-handle-registry'
import { MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from '../session/mobile-clipboard-image-upload-chunk'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/bridge-native-verbs'
import { createNativeMediaVerbServer, type NativeMediaFile } from './native-media'

const CACHE = 'file:///cache'

function fakeFile(bytes: Uint8Array): NativeMediaFile {
  return {
    size: bytes.byteLength,
    open: () => {
      let cursor = 0
      return {
        get offset() {
          return cursor
        },
        set offset(next: number | null) {
          cursor = next ?? 0
        },
        readBytes: (length: number) => {
          const slice = bytes.subarray(cursor, cursor + length)
          cursor += slice.byteLength
          return slice
        },
        close: () => {}
      }
    }
  }
}

function bytesOf(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 251)
}

type Harness = {
  serve: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
  registry: MediaHandleRegistry
  readonly discarded: string[]
  readonly files: Map<string, Uint8Array>
  readonly written: { uri: string; base64: string }[]
}

function harness(
  overrides: Partial<Parameters<typeof createNativeMediaVerbServer>[0]> = {}
): Harness {
  const discarded: string[] = []
  const files = new Map<string, Uint8Array>()
  const written: { uri: string; base64: string }[] = []
  const registry = new MediaHandleRegistry({
    now: () => 1_000,
    discard: (uri) => discarded.push(uri)
  })
  const serve = createNativeMediaVerbServer({
    registry,
    requestLibraryPermission: () => Promise.resolve({ granted: true }),
    launchLibrary: () =>
      Promise.resolve({
        canceled: false,
        assets: [{ uri: `${CACHE}/lib.png`, mimeType: 'image/png', width: 4, height: 3 }]
      }),
    launchFiles: () =>
      Promise.resolve({
        canceled: false,
        assets: [{ uri: `${CACHE}/doc.pdf`, mimeType: 'application/pdf' }]
      }),
    readClipboardImage: () => Promise.resolve(null),
    stageBase64: (base64) => {
      const uri = `${CACHE}/staged-${written.length}.png`
      written.push({ uri, base64 })
      files.set(
        uri,
        Uint8Array.from(atob(base64), (char) => char.codePointAt(0) ?? 0)
      )
      return uri
    },
    openFile: (uri) => fakeFile(files.get(uri) ?? new Uint8Array()),
    discard: (uri) => discarded.push(uri),
    ...overrides
  })
  return { serve, registry, discarded, files, written }
}

function refusalOf(error: unknown): string | null {
  return readShellRefusalCode(error)
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('picking', () => {
  it('runs the library permission prompt and answers a handle per asset', async () => {
    const probe = harness()
    probe.files.set(`${CACHE}/lib.png`, bytesOf(64))
    const result = await probe.serve('native.media.pick', { source: 'library', multiple: false })
    const parsed = mediaPickResultSchema.parse(result)
    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0]).toMatchObject({
      mime: 'image/png',
      byteLength: 64,
      width: 4,
      height: 3
    })
    expect(probe.registry.liveCount()).toBe(1)
  })

  it('refuses a library pick the user denied, by its own name', async () => {
    const probe = harness({ requestLibraryPermission: () => Promise.resolve({ granted: false }) })
    await expect(
      probe.serve('native.media.pick', { source: 'library', multiple: false })
    ).rejects.toSatisfy((error) => refusalOf(error) === 'native_media_permission_denied')
  })

  it('answers no items when the user cancels, which is not a refusal', async () => {
    for (const source of ['library', 'files'] as const) {
      const probe = harness({
        launchLibrary: () => Promise.resolve({ canceled: true, assets: null }),
        launchFiles: () => Promise.resolve({ canceled: true, assets: null })
      })
      await expect(probe.serve('native.media.pick', { source, multiple: true })).resolves.toEqual({
        items: []
      })
    }
  })

  it('takes a file from the document picker with no pixel dimensions', async () => {
    const probe = harness()
    probe.files.set(`${CACHE}/doc.pdf`, bytesOf(10))
    const result = mediaPickResultSchema.parse(
      await probe.serve('native.media.pick', { source: 'files', multiple: false })
    )
    expect(result.items[0]).toMatchObject({ mime: 'application/pdf', byteLength: 10 })
    expect(result.items[0]).not.toHaveProperty('width')
  })

  it('stages what the pasteboard holds, so an image crosses as a handle and not a value', async () => {
    const probe = harness({
      readClipboardImage: () =>
        Promise.resolve({ data: btoa('pasted-bytes'), size: { width: 2, height: 2 } })
    })
    const result = mediaPickResultSchema.parse(
      await probe.serve('native.media.pick', { source: 'clipboard', multiple: false })
    )
    expect(probe.written).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      mime: 'image/png',
      byteLength: 12,
      width: 2,
      height: 2
    })
  })

  it('answers no items for an empty pasteboard', async () => {
    const probe = harness()
    await expect(
      probe.serve('native.media.pick', { source: 'clipboard', multiple: false })
    ).resolves.toEqual({ items: [] })
  })

  it('refuses an item bigger than the staging ceiling, and deletes what it picked', async () => {
    const probe = harness({
      openFile: () => ({ size: 64 * 1024 * 1024, open: () => fakeFile(new Uint8Array()).open() })
    })
    await expect(
      probe.serve('native.media.pick', { source: 'library', multiple: false })
    ).rejects.toSatisfy((error) => refusalOf(error) === 'native_media_too_large')
    expect(probe.discarded).toEqual([`${CACHE}/lib.png`])
  })
})

describe('reading chunks', () => {
  async function staged(byteLength: number): Promise<{ probe: Harness; handle: string }> {
    const probe = harness()
    probe.files.set(`${CACHE}/lib.png`, bytesOf(byteLength))
    const result = mediaPickResultSchema.parse(
      await probe.serve('native.media.pick', { source: 'library', multiple: false })
    )
    return { probe, handle: result.items[0]?.handle ?? '' }
  }

  it('reads an 18 MiB item in order to eof, and the bytes come back whole', async () => {
    const total = 1_000_000
    const { probe, handle } = await staged(total)
    const source = bytesOf(total)
    const collected: number[] = []
    let offset = 0
    let reads = 0
    for (;;) {
      const chunk = mediaReadChunkResultSchema.parse(
        await probe.serve('native.media.readChunk', {
          handle,
          offset,
          length: BRIDGE_MEDIA_READ_CHUNK_MAX_BYTES
        })
      )
      reads += 1
      const bytes = atob(chunk.base64)
      for (let index = 0; index < bytes.length; index += 1) {
        collected.push(bytes.codePointAt(index) ?? 0)
      }
      offset += bytes.length
      if (chunk.eof) {
        break
      }
    }
    expect(reads).toBe(Math.ceil(total / BRIDGE_MEDIA_READ_CHUNK_MAX_BYTES))
    expect(collected).toEqual([...source])
  })

  it('refuses a read for a handle the page released', async () => {
    const { probe, handle } = await staged(64)
    await expect(probe.serve('native.media.release', { handle })).resolves.toEqual({
      released: true
    })
    await expect(
      probe.serve('native.media.readChunk', { handle, offset: 0, length: 16 })
    ).rejects.toSatisfy((error) => refusalOf(error) === 'native_media_handle_unknown')
  })

  it('refuses a read that starts past the end', async () => {
    const { probe, handle } = await staged(64)
    await expect(
      probe.serve('native.media.readChunk', { handle, offset: 64, length: 16 })
    ).rejects.toSatisfy((error) => refusalOf(error) === 'native_media_range')
  })
})

describe('releasing', () => {
  it('deletes the staged file and answers false the second time', async () => {
    const probe = harness()
    probe.files.set(`${CACHE}/lib.png`, bytesOf(8))
    const result = mediaPickResultSchema.parse(
      await probe.serve('native.media.pick', { source: 'library', multiple: false })
    )
    const handle = result.items[0]?.handle ?? ''
    await expect(probe.serve('native.media.release', { handle })).resolves.toEqual({
      released: true
    })
    expect(probe.discarded).toEqual([`${CACHE}/lib.png`])
    await expect(probe.serve('native.media.release', { handle })).resolves.toEqual({
      released: false
    })
  })
})

describe('what the largest reply weighs', () => {
  it('carries a full chunk in one frame, under the frame cap and far under the reply ceiling', () => {
    const payload = {
      id: 'a'.repeat(22),
      ok: true as const,
      result: {
        base64: 'a'.repeat(MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS),
        eof: false
      }
    }
    const split = splitBridgeReply('a'.repeat(22), payload)
    expect(split.ok).toBe(true)
    // One frame, not a chunked reply: base64 carries no character JSON has to escape, so the
    // string costs exactly its length and the envelope is the only thing on top of it.
    expect(split.ok === true && split.frames).toHaveLength(1)
    const bytes = utf8ByteLength(JSON.stringify(split.ok === true ? split.frames[0] : null))
    expect(bytes).toBeLessThan(BRIDGE_MAX_MESSAGE_BYTES)
    expect(bytes).toBeLessThan(BRIDGE_MAX_REPLY_BYTES)
    // The measured number, so a cap or an envelope field that moves shows up here as a diff.
    expect(bytes).toBe(524_427)
  })
})
