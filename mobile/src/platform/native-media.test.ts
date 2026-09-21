/** The device half of the media verbs: the picker it runs, the bytes it moves, the file it deletes. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { splitBridgeReply } from '../mobile-web-shell/bridge/bridge-reply-chunking'
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_REPLY_BYTES,
  utf8ByteLength
} from '../mobile-web-shell/bridge/bridge-caps'
import {
  BRIDGE_MEDIA_MAX_LIVE_HANDLES,
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
  readonly copied: { from: string; to: string }[]
}

function harness(
  overrides: Partial<Parameters<typeof createNativeMediaVerbServer>[0]> = {}
): Harness {
  const discarded: string[] = []
  const files = new Map<string, Uint8Array>()
  const written: { uri: string; base64: string }[] = []
  const copied: { from: string; to: string }[] = []
  const registry = new MediaHandleRegistry({
    now: () => 1_000,
    discard: (uri) => discarded.push(uri)
  })
  const serve = createNativeMediaVerbServer({
    registry,
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
    copyIntoCache: (uri: string) => {
      const destination = `${CACHE}/copy-${copied.length}.bin`
      copied.push({ from: uri, to: destination })
      files.set(destination, files.get(uri) ?? new Uint8Array())
      return destination
    },
    openFile: (uri) => fakeFile(files.get(uri) ?? new Uint8Array()),
    discard: (uri) => discarded.push(uri),
    ownsStagedUri: (uri: string) => uri.startsWith('file:'),
    ...overrides
  })
  return { serve, registry, discarded, files, written, copied }
}

function refusalOf(error: unknown): string | null {
  return readShellRefusalCode(error)
}

beforeEach(() => {
  handles.length = 0
  vi.restoreAllMocks()
})

describe('picking', () => {
  it('answers a handle per asset for a library pick', async () => {
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

  it('offers the picker only the room the registry has left', async () => {
    const limits: (number | undefined)[] = []
    const probe = harness({
      launchLibrary: (options: { multiple: boolean; limit: number }) => {
        limits.push(options.limit)
        return Promise.resolve({ canceled: true })
      }
    })
    await probe.serve('native.media.pick', { source: 'library', multiple: true })
    expect(limits).toEqual([BRIDGE_MEDIA_MAX_LIVE_HANDLES])

    probe.files.set(`${CACHE}/held.png`, bytesOf(4))
    probe.registry.mint([{ uri: `${CACHE}/held.png`, mime: 'image/png', byteLength: 4 }])
    probe.registry.mint([{ uri: `${CACHE}/held.png`, mime: 'image/png', byteLength: 4 }])
    await probe.serve('native.media.pick', { source: 'library', multiple: true })
    expect(limits).toEqual([BRIDGE_MEDIA_MAX_LIVE_HANDLES, BRIDGE_MEDIA_MAX_LIVE_HANDLES - 2])
  })

  it('refuses a pick up front when nothing is left, before the OS copies a byte', async () => {
    // Without this the OS copies every selected asset into the cache and the registry then
    // refuses the whole pick, so the user waits through a multi-select for nothing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const launches: number[] = []
    const probe = harness({
      launchLibrary: () => {
        launches.push(1)
        return Promise.resolve({ canceled: true })
      }
    })
    probe.files.set(`${CACHE}/held.png`, bytesOf(4))
    for (let index = 0; index < BRIDGE_MEDIA_MAX_LIVE_HANDLES; index += 1) {
      probe.registry.mint([{ uri: `${CACHE}/held.png`, mime: 'image/png', byteLength: 4 }])
    }
    for (const source of ['library', 'files', 'clipboard'] as const) {
      await expect(probe.serve('native.media.pick', { source, multiple: true })).rejects.toSatisfy(
        (error) => refusalOf(error) === 'native_media_handle_cap'
      )
    }
    expect(launches).toEqual([])
    warn.mockRestore()
  })

  it('weighs a provider item before copying it, so an oversized one is never held in memory', async () => {
    // `copyPickedMediaIntoCache` reads the whole file into memory. Weighing only the copy would
    // mean holding a 64 MiB item to find out it is too big. Nothing is ours yet at that point, so
    // nothing is discarded either.
    const probe = harness({
      openFile: () => ({ size: 64 * 1024 * 1024, open: () => fakeFile(new Uint8Array()).open() }),
      launchLibrary: () =>
        Promise.resolve({
          canceled: false,
          assets: [{ uri: 'content://media/external/images/media/42', mimeType: 'image/jpeg' }]
        })
    })
    await expect(
      probe.serve('native.media.pick', { source: 'library', multiple: false })
    ).rejects.toSatisfy((error) => refusalOf(error) === 'native_media_too_large')
    expect(probe.copied).toEqual([])
    expect(probe.discarded).toEqual([])
  })

  it('refuses a provider item it cannot weigh, rather than reading an unknown number of bytes', async () => {
    // `SAFDocumentFile.length()` answers 0 when the provider reports no size, and there is no
    // bounded read to fall back on: `File.open()`, `readableStream()` and `writableStream()` all
    // go through `javaFile`, which throws outright for a content uri, so `bytesSync()` is the only
    // read that works and it is all or nothing. An item this shell cannot weigh is not copied.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const probe = harness({
      openFile: () => ({ size: 0, open: () => fakeFile(new Uint8Array()).open() }),
      launchLibrary: () =>
        Promise.resolve({
          canceled: false,
          assets: [{ uri: 'content://media/external/images/media/42', mimeType: 'image/jpeg' }]
        })
    })
    await expect(
      probe.serve('native.media.pick', { source: 'library', multiple: false })
    ).rejects.toThrow(/could not be weighed/)
    expect(probe.copied).toEqual([])
    expect(probe.discarded).toEqual([])
    warn.mockRestore()
  })

  it('refuses a Files result over the room before it stages any of it', async () => {
    // `getDocumentAsync` takes no selection limit, so the room `pick` hands it is advisory and the
    // user can return more than the registry will hold. Counted before staging: otherwise every
    // asset is copied into the cache and `mint` refuses the lot afterwards.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const probe = harness({
      launchFiles: () =>
        Promise.resolve({
          canceled: false,
          assets: Array.from({ length: BRIDGE_MEDIA_MAX_LIVE_HANDLES + 1 }, (_, index) => ({
            uri: `${CACHE}/doc-${index}.pdf`,
            mimeType: 'application/pdf'
          }))
        })
    })
    for (let index = 0; index <= BRIDGE_MEDIA_MAX_LIVE_HANDLES; index += 1) {
      probe.files.set(`${CACHE}/doc-${index}.pdf`, bytesOf(4))
    }
    await expect(
      probe.serve('native.media.pick', { source: 'files', multiple: true })
    ).rejects.toSatisfy((error) => refusalOf(error) === 'native_media_handle_cap')
    expect(probe.registry.liveCount()).toBe(0)
    // Nothing of ours existed to sweep: the picker's own copies are its business.
    expect(probe.discarded).toEqual([])
    warn.mockRestore()
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

describe('a provider uri the Android picker can answer', () => {
  it('copies it into the cache and mints the handle over the copy, bytes intact', async () => {
    // `MediaHandler.readExtras` has a reachable arm: when the resolver cannot type the asset it
    // answers `ImagePickerAsset(type = null, uri = uri.toString())`, the provider's own uri,
    // uncopied. The OS completed that pick, so refusing it loses a photo the user chose.
    const probe = harness({
      launchLibrary: () =>
        Promise.resolve({
          canceled: false,
          assets: [{ uri: 'content://media/external/images/media/42', mimeType: null }]
        })
    })
    probe.files.set('content://media/external/images/media/42', bytesOf(300))
    const result = mediaPickResultSchema.parse(
      await probe.serve('native.media.pick', { source: 'library', multiple: false })
    )
    const item = result.items[0]
    expect(item).toMatchObject({ mime: 'application/octet-stream', byteLength: 300 })
    expect(probe.copied).toEqual([
      { from: 'content://media/external/images/media/42', to: `${CACHE}/copy-0.bin` }
    ])

    const chunk = mediaReadResultSchema.parse(
      await probe.serve('native.media.read', {
        handle: item?.handle ?? '',
        offset: 0,
        length: 300
      })
    )
    const bytes = atob(chunk.base64)
    expect([...bytes].map((char) => char.codePointAt(0))).toEqual([...bytesOf(300)])

    // The copy is what release deletes. The provider's uri was never ours to unlink.
    await probe.serve('native.media.release', { handle: item?.handle ?? '' })
    expect(probe.discarded).toEqual([`${CACHE}/copy-0.bin`])
  })

  it('refuses a uri the copy could not adopt either, rather than minting over it', async () => {
    // A copy that answered something this shell still cannot delete. Nothing here is ours, and
    // the provider's own uri least of all: unlinking it is not this app's to attempt, and the
    // failure path must leave it alone rather than sweep what it never owned.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const probe = harness({
      copyIntoCache: (uri: string) => uri,
      launchLibrary: () =>
        Promise.resolve({
          canceled: false,
          assets: [{ uri: 'content://media/external/images/media/42', mimeType: 'image/jpeg' }]
        })
    })
    // Weighable, so the ownership guard is what fires rather than the pre-read weigh above it.
    probe.files.set('content://media/external/images/media/42', bytesOf(64))
    await expect(
      probe.serve('native.media.pick', { source: 'library', multiple: false })
    ).rejects.toThrow(/this shell does not own/)
    expect(probe.registry.liveCount()).toBe(0)
    expect(probe.discarded).toEqual([])
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
