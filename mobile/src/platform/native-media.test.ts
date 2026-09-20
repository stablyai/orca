/** The device half of the media verbs: the picker it runs, the bytes it moves, the file it deletes. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { splitBridgeReply } from '../mobile-web-shell/bridge/bridge-reply-chunking'
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_REPLY_BYTES,
  utf8ByteLength
} from '../mobile-web-shell/bridge/bridge-caps'
import {
  BRIDGE_MEDIA_READ_MAX_BYTES,
  mediaPickResultSchema,
  mediaReadResultSchema
} from '../mobile-web-shell/bridge/bridge-media-verbs'
import { readShellRefusalCode } from '../mobile-web-shell/bridge-host-errors'
import { MediaHandleRegistry } from '../mobile-web-shell/media-handle-registry'
import { MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from '../session/mobile-clipboard-image-upload-chunk'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/bridge-native-verbs'
import { createNativeMediaVerbServer, type NativeMediaFile } from './native-media'

const CACHE = 'file:///cache'

/** Every handle the read path opened, and whether it was closed. A file handle a shell leaks is
 *  invisible on a fake and a file descriptor on a phone. */
const handles: { closed: boolean }[] = []

function fakeFile(bytes: Uint8Array): NativeMediaFile {
  return {
    size: bytes.byteLength,
    open: () => {
      let cursor = 0
      const ledger = { closed: false }
      handles.push(ledger)
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
        close: () => {
          ledger.closed = true
        }
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
    ownsStagedUri: (uri: string) => uri.startsWith('file:'),
    ...overrides
  })
  return { serve, registry, discarded, files, written }
}

function refusalOf(error: unknown): string | null {
  return readShellRefusalCode(error)
}

beforeEach(() => {
  handles.length = 0
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

  it('strips the data-url prefix the pasteboard puts in front of its base64', async () => {
    // `getImageAsync` answers `data:image/png;base64,...`, which is what an `<Image>` source wants
    // and not what a file wants. Staged unstripped, every byte of the file is shifted by the
    // prefix and the page decodes a corrupt image with no error anywhere.
    const probe = harness({
      readClipboardImage: () =>
        Promise.resolve({ data: `data:image/png;base64,${btoa('pasted-bytes')}` })
    })
    await probe.serve('native.media.pick', { source: 'clipboard', multiple: false })
    expect(probe.written).toEqual([{ uri: `${CACHE}/staged-0.png`, base64: btoa('pasted-bytes') }])
  })

  it('names a picker that reported no type, rather than answering an empty mime', async () => {
    // An empty string is not a mime the result schema takes, so the alternative to this floor is
    // `native_verb_result` — a shell bug's code for a document picker doing what it may do.
    const probe = harness({
      launchFiles: () => Promise.resolve({ canceled: false, assets: [{ uri: `${CACHE}/doc.pdf` }] })
    })
    probe.files.set(`${CACHE}/doc.pdf`, bytesOf(3))
    const result = mediaPickResultSchema.parse(
      await probe.serve('native.media.pick', { source: 'files', multiple: false })
    )
    expect(result.items[0]).toMatchObject({ mime: 'application/octet-stream', byteLength: 3 })
  })

  it('reads the cancel off the flag, not off an absent asset list', async () => {
    // Both pickers answer `assets: null` when they answer `canceled: true` today, so a handler
    // keyed on the list alone passes every fixture in this file. The flag is the contract; a
    // picker version that started sending the half-selected list with it would otherwise stage it.
    for (const source of ['library', 'files'] as const) {
      const probe = harness({
        launchLibrary: () =>
          Promise.resolve({ canceled: true, assets: [{ uri: `${CACHE}/lib.png` }] }),
        launchFiles: () =>
          Promise.resolve({ canceled: true, assets: [{ uri: `${CACHE}/doc.pdf` }] })
      })
      probe.files.set(`${CACHE}/lib.png`, bytesOf(2))
      probe.files.set(`${CACHE}/doc.pdf`, bytesOf(2))
      await expect(probe.serve('native.media.pick', { source, multiple: true })).resolves.toEqual({
        items: []
      })
      expect(probe.registry.liveCount(), source).toBe(0)
    }
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

  it('reads a million-byte item in order to eof, and the bytes come back whole', async () => {
    // Three chunks, which is enough to pin the ordering and the join here. The largest item a
    // pick may stage runs in `bridge-host-media-verbs.test.ts`, where the frames are serialized
    // and the size is the one that matters.
    const total = 1_000_000
    const { probe, handle } = await staged(total)
    const source = bytesOf(total)
    const collected: number[] = []
    let offset = 0
    let reads = 0
    for (;;) {
      const chunk = mediaReadResultSchema.parse(
        await probe.serve('native.media.read', {
          handle,
          offset,
          length: BRIDGE_MEDIA_READ_MAX_BYTES
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
    expect(reads).toBe(Math.ceil(total / BRIDGE_MEDIA_READ_MAX_BYTES))
    expect(collected).toEqual([...source])
  })

  it('answers exactly the bytes a short read asked for, at the offset it asked for', async () => {
    // The only case that separates the range from the cap. Every other read here asks for a whole
    // chunk, so a handler that ignored `length` and read to the end of the file would pass them
    // all: the file is shorter than one chunk, and the fake clamps at its own size.
    const { probe, handle } = await staged(1000)
    const source = bytesOf(1000)
    const chunk = mediaReadResultSchema.parse(
      await probe.serve('native.media.read', { handle, offset: 400, length: 16 })
    )
    const bytes = atob(chunk.base64)
    expect(bytes.length).toBe(16)
    expect(chunk.eof).toBe(false)
    expect([...bytes].map((char) => char.codePointAt(0))).toEqual([...source.subarray(400, 416)])
  })

  it('closes the file handle it opened, on the way out and on the way through a throw', async () => {
    const { probe, handle } = await staged(64)
    await probe.serve('native.media.read', { handle, offset: 0, length: 16 })
    expect(handles).toHaveLength(1)
    expect(handles[0]?.closed).toBe(true)

    const failing = harness({
      openFile: () => ({
        size: 64,
        open: () => {
          const ledger = { closed: false }
          handles.push(ledger)
          return {
            offset: 0,
            readBytes: (): Uint8Array => {
              throw new Error('the device stopped reading')
            },
            close: () => {
              ledger.closed = true
            }
          }
        }
      })
    })
    failing.files.set(`${CACHE}/lib.png`, bytesOf(64))
    const picked = mediaPickResultSchema.parse(
      await failing.serve('native.media.pick', { source: 'library', multiple: false })
    )
    await expect(
      failing.serve('native.media.read', {
        handle: picked.items[0]?.handle ?? '',
        offset: 0,
        length: 16
      })
    ).rejects.toThrow(/stopped reading/)
    expect(handles.at(-1)?.closed).toBe(true)
  })

  it('refuses a read for a handle the page released', async () => {
    const { probe, handle } = await staged(64)
    await expect(probe.serve('native.media.release', { handle })).resolves.toEqual({
      released: true
    })
    await expect(
      probe.serve('native.media.read', { handle, offset: 0, length: 16 })
    ).rejects.toSatisfy((error) => refusalOf(error) === 'native_media_handle_unknown')
  })

  it('refuses a read that starts past the end', async () => {
    const { probe, handle } = await staged(64)
    await expect(
      probe.serve('native.media.read', { handle, offset: 64, length: 16 })
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

describe('a uri this shell could not own', () => {
  it('refuses to mint a handle over one, rather than leaking the file behind it', async () => {
    // The Android hazard. Both pickers are configured to hand back a `file:` copy in this app's
    // own cache, and the whole handle contract rests on that: `release` is a delete and the TTL
    // sweep is a delete. A provider that answered `content://media/...` instead would mint a
    // handle over a file this shell can neither size nor delete, and every sweep would be a
    // silent no-op. Refused where the assumption is made.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const probe = harness({
      launchLibrary: () =>
        Promise.resolve({
          canceled: false,
          assets: [{ uri: 'content://media/external/images/media/42', mimeType: 'image/jpeg' }]
        })
    })
    await expect(
      probe.serve('native.media.pick', { source: 'library', multiple: false })
    ).rejects.toThrow(/this shell does not own/)
    expect(probe.registry.liveCount()).toBe(0)
    warn.mockRestore()
  })

  it('takes the cache copy both pickers are configured to produce', async () => {
    const probe = harness()
    probe.files.set(`${CACHE}/lib.png`, bytesOf(4))
    await expect(
      probe.serve('native.media.pick', { source: 'library', multiple: false })
    ).resolves.toMatchObject({ items: [{ byteLength: 4 }] })
  })
})
