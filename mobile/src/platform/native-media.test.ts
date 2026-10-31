import { Buffer } from 'node:buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { splitBridgeReply } from '../mobile-web-shell/bridge/bridge-reply-chunking'
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_REPLY_BYTES,
  utf8ByteLength
} from '../mobile-web-shell/bridge/bridge-caps'
import {
  BRIDGE_MEDIA_MAX_LIVE_HANDLES,
  BRIDGE_MEDIA_NAME_MAX_CHARS,
  BRIDGE_MEDIA_READ_MAX_BYTES,
  mediaNameResultSchema,
  mediaPickResultSchema,
  mediaReadResultSchema
} from '../mobile-web-shell/bridge/bridge-media-verbs'
import { readShellRefusalCode } from '../mobile-web-shell/bridge-host-errors'
import { MediaHandleRegistry } from '../mobile-web-shell/media-handle-registry'
import { MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from '../session/mobile-clipboard-image-upload-chunk'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/bridge-native-verbs'
import { createNativeMediaVerbServer, type NativeMediaFile } from './native-media'

const CACHE = 'file:///cache'

// Track closed handles explicitly because a fake otherwise hides native descriptor leaks.
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
  // A fixed stream exposes shifted offsets and reordered chunks without a short repeating pattern.
  let state = 0x9e3779b9
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    bytes[index] = state >>> 24
  }
  return bytes
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
  const discard = (uri: string): void => {
    discarded.push(uri)
    files.delete(uri)
  }
  const registry = new MediaHandleRegistry({ now: () => 1_000, discard })
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
    discard,
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
  it('leaves a late provider original untouched and skips its whole-file copy', async () => {
    const providerUri = 'content://media/external/images/media/42'
    const probe = harness({
      launchLibrary: async () => {
        probe.registry.releaseAll()
        return { canceled: false, assets: [{ uri: providerUri, mimeType: 'image/jpeg' }] }
      }
    })
    probe.files.set(providerUri, bytesOf(1024 * 1024))
    await expect(
      probe.serve('native.media.pick', { source: 'library', multiple: false })
    ).resolves.toEqual({ items: [] })
    expect(probe.copied).toEqual([])
    expect(probe.discarded).toEqual([])
    expect(probe.registry.liveCount()).toBe(0)
    expect(probe.files.get(providerUri)?.byteLength).toBe(1024 * 1024)
  })

  it('does not stage clipboard bytes that arrive after session cleanup', async () => {
    const probe = harness({
      readClipboardImage: async () => {
        probe.registry.releaseAll()
        return { data: 'data:image/png;base64,AQID' }
      }
    })
    await expect(
      probe.serve('native.media.pick', { source: 'clipboard', multiple: false })
    ).resolves.toEqual({ items: [] })
    expect(probe.written).toEqual([])
    expect(probe.discarded).toEqual([])
    expect(probe.registry.liveCount()).toBe(0)
  })

  it('discards every copy if cleanup runs between staging and minting', async () => {
    const providerUris = ['content://media/1', 'content://media/2']
    const probe = harness({
      launchLibrary: () =>
        Promise.resolve({
          canceled: false,
          assets: providerUris.map((uri) => ({ uri, mimeType: 'image/jpeg' }))
        })
    })
    for (const uri of providerUris) {
      probe.files.set(uri, bytesOf(4096))
    }
    const picked = probe.serve('native.media.pick', { source: 'library', multiple: true })
    await Promise.resolve()
    expect(probe.copied).toHaveLength(2)
    expect(probe.registry.liveCount()).toBe(0)
    probe.registry.releaseAll()
    const [live] = probe.registry.mint([
      { uri: `${CACHE}/successor.png`, byteLength: 64, mime: 'image/png' }
    ])
    await expect(picked).resolves.toEqual({ items: [] })
    expect(probe.discarded).toEqual(probe.copied.map(({ to }) => to))
    expect(probe.registry.liveCount()).toBe(1)
    expect(probe.registry.read(live?.handle ?? '', 0, 64)).toMatchObject({
      uri: `${CACHE}/successor.png`,
      end: 64,
      eof: true
    })
  })

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
    // Clipboard returns a data URI; strip its prefix or staged bytes become a silently corrupt image.
    const probe = harness({
      readClipboardImage: () =>
        Promise.resolve({ data: `data:image/png;base64,${btoa('pasted-bytes')}` })
    })
    await probe.serve('native.media.pick', { source: 'clipboard', multiple: false })
    expect(probe.written).toEqual([{ uri: `${CACHE}/staged-0.png`, base64: btoa('pasted-bytes') }])
  })

  it('names a picker that reported no type, rather than answering an empty mime', async () => {
    const probe = harness({
      launchFiles: () => Promise.resolve({ canceled: false, assets: [{ uri: `${CACHE}/doc.pdf` }] })
    })
    probe.files.set(`${CACHE}/doc.pdf`, bytesOf(3))
    const result = mediaPickResultSchema.parse(
      await probe.serve('native.media.pick', { source: 'files', multiple: false })
    )
    expect(result.items[0]).toMatchObject({ mime: 'application/octet-stream', byteLength: 3 })
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
    // Weigh before copying: copyIntoCache reads the entire source into memory.
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
    // Provider size zero means unknown or empty; Expo has no bounded content: read to safely discover its size.
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

  it.each([0, 2])(
    'deletes an over-cap Files result while preserving %i prior handles',
    async (held) => {
      const liveUris = Array.from({ length: held }, (_, index) => `${CACHE}/held-${index}.png`)
      const returnedUris = Array.from(
        { length: BRIDGE_MEDIA_MAX_LIVE_HANDLES - held + 1 },
        (_, index) => `${CACHE}/doc-${index}.pdf`
      )
      const probe = harness({
        launchFiles: () =>
          Promise.resolve({
            canceled: false,
            assets: returnedUris.map((uri) => ({ uri, mimeType: 'application/pdf' }))
          })
      })
      for (const uri of liveUris) {
        probe.files.set(uri, new Uint8Array(4096))
      }
      probe.registry.mint(liveUris.map((uri) => ({ uri, mime: 'image/png', byteLength: 4096 })))
      for (const uri of returnedUris) {
        probe.files.set(uri, new Uint8Array(1024 * 1024))
      }
      const storedBytes = (): number =>
        [...probe.files.values()].reduce((bytes, file) => bytes + file.byteLength, 0)
      expect(storedBytes()).toBe(returnedUris.length * 1024 * 1024 + held * 4096)
      await expect(
        probe.serve('native.media.pick', { source: 'files', multiple: true })
      ).rejects.toSatisfy((error) => refusalOf(error) === 'native_media_handle_cap')
      expect(probe.registry.liveCount()).toBe(held)
      expect(probe.discarded).toEqual(returnedUris)
      expect([...probe.files.keys()]).toEqual(liveUris)
      expect(storedBytes()).toBe(held * 4096)
      expect(probe.copied).toEqual([])
      expect(probe.written).toEqual([])
      probe.registry.releaseAll()
      expect(probe.files.size).toBe(0)
    }
  )

  it('leaves provider originals intact when refusing an over-cap mixed result', async () => {
    const providerUri = 'content://media/external/images/media/42'
    const ownedUris = Array.from(
      { length: BRIDGE_MEDIA_MAX_LIVE_HANDLES },
      (_, index) => `${CACHE}/picked-${index}.png`
    )
    const probe = harness({
      launchFiles: () =>
        Promise.resolve({
          canceled: false,
          assets: [providerUri, ...ownedUris].map((uri) => ({ uri, mimeType: 'image/png' }))
        })
    })
    for (const uri of [providerUri, ...ownedUris]) {
      probe.files.set(uri, new Uint8Array(1024 * 1024))
    }
    await expect(
      probe.serve('native.media.pick', { source: 'files', multiple: true })
    ).rejects.toSatisfy((error) => refusalOf(error) === 'native_media_handle_cap')
    expect(probe.discarded).toEqual(ownedUris)
    expect([...probe.files.keys()]).toEqual([providerUri])
    expect(probe.files.get(providerUri)?.byteLength).toBe(1024 * 1024)
    expect(probe.registry.liveCount()).toBe(0)
    expect(probe.copied).toEqual([])
  })

  it('continues sweeping refused copies when one file cannot be deleted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const returnedUris = Array.from(
      { length: BRIDGE_MEDIA_MAX_LIVE_HANDLES + 1 },
      (_, index) => `${CACHE}/doc-${index}.pdf`
    )
    const probe = harness({
      launchFiles: () =>
        Promise.resolve({
          canceled: false,
          assets: returnedUris.map((uri) => ({ uri, mimeType: 'application/pdf' }))
        }),
      discard: (uri) => {
        probe.discarded.push(uri)
        if (uri === returnedUris[0]) {
          throw new Error('cache file is busy')
        }
        probe.files.delete(uri)
      }
    })
    try {
      for (const uri of returnedUris) {
        probe.files.set(uri, new Uint8Array(1024 * 1024))
      }
      await expect(
        probe.serve('native.media.pick', { source: 'files', multiple: true })
      ).rejects.toSatisfy((error) => refusalOf(error) === 'native_media_handle_cap')
      expect(probe.discarded).toEqual(returnedUris)
      expect([...probe.files.keys()]).toEqual([returnedUris[0]])
      expect(probe.registry.liveCount()).toBe(0)
    } finally {
      warn.mockRestore()
    }
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
    const total = 1_000_000
    const { probe, handle } = await staged(total)
    const source = bytesOf(total)
    const collected = new Uint8Array(total)
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
      collected.set(Buffer.from(bytes, 'latin1'), offset)
      offset += bytes.length
      expect(chunk.eof).toBe(offset === total)
      if (chunk.eof) {
        break
      }
    }
    expect(reads).toBe(Math.ceil(total / BRIDGE_MEDIA_READ_MAX_BYTES))
    expect(offset).toBe(total)
    expect(Buffer.compare(collected, source)).toBe(0)
  })

  it('answers exactly the bytes a short read asked for, at the offset it asked for', async () => {
    // Ask for a partial range: whole-file reads would also pass cases whose files fit below the cap.
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

  it('refuses a read that starts at the end', async () => {
    const { probe, handle } = await staged(64)
    await expect(
      probe.serve('native.media.read', { handle, offset: 64, length: 16 })
    ).rejects.toSatisfy((error) => refusalOf(error) === 'native_media_range')
  })
})

describe('naming', () => {
  async function pickOne(probe: Harness, source: 'library' | 'files'): Promise<string> {
    const result = mediaPickResultSchema.parse(
      await probe.serve('native.media.pick', { source, multiple: false })
    )
    return result.items[0]?.handle ?? ''
  }

  it("answers the document picker's name for a file, never on the picked item itself", async () => {
    const probe = harness({
      launchFiles: () =>
        Promise.resolve({
          canceled: false,
          assets: [{ uri: `${CACHE}/doc.pdf`, mimeType: 'application/pdf', name: 'auth-spec.pdf' }]
        })
    })
    probe.files.set(`${CACHE}/doc.pdf`, bytesOf(10))
    const result = mediaPickResultSchema.parse(
      await probe.serve('native.media.pick', { source: 'files', multiple: false })
    )
    expect(result.items[0]).not.toHaveProperty('name')
    await expect(
      probe.serve('native.media.name', { handle: result.items[0]?.handle ?? '' })
    ).resolves.toEqual({ name: 'auth-spec.pdf' })
  })

  it('answers null where the picker reported no name', async () => {
    const probe = harness()
    probe.files.set(`${CACHE}/lib.png`, bytesOf(4))
    const handle = await pickOne(probe, 'library')
    await expect(probe.serve('native.media.name', { handle })).resolves.toEqual({ name: null })
  })

  it('keeps the extension of a name too long for the verb', async () => {
    const long = `${'a'.repeat(400)}.pdf`
    const probe = harness({
      launchFiles: () =>
        Promise.resolve({
          canceled: false,
          assets: [{ uri: `${CACHE}/doc.pdf`, mimeType: 'application/pdf', name: long }]
        })
    })
    probe.files.set(`${CACHE}/doc.pdf`, bytesOf(4))
    const handle = await pickOne(probe, 'files')
    const { name } = mediaNameResultSchema.parse(await probe.serve('native.media.name', { handle }))
    expect(name).toHaveLength(BRIDGE_MEDIA_NAME_MAX_CHARS)
    expect(name?.endsWith('.pdf')).toBe(true)
  })

  it('refuses a handle the page already released', async () => {
    const probe = harness()
    probe.files.set(`${CACHE}/lib.png`, bytesOf(4))
    const handle = await pickOne(probe, 'library')
    await probe.serve('native.media.release', { handle })
    await expect(probe.serve('native.media.name', { handle })).rejects.toSatisfy(
      (error) => refusalOf(error) === 'native_media_handle_unknown'
    )
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
    // Base64 needs no JSON escaping, so serialized size is its length plus the envelope.
    expect(split.ok === true && split.frames).toHaveLength(1)
    const bytes = utf8ByteLength(JSON.stringify(split.ok === true ? split.frames[0] : null))
    expect(bytes).toBeLessThan(BRIDGE_MAX_MESSAGE_BYTES)
    expect(bytes).toBeLessThan(BRIDGE_MAX_REPLY_BYTES)
  })
})

describe('a provider uri the Android picker can answer', () => {
  it('copies it into the cache and mints the handle over the copy, bytes intact', async () => {
    // Android may return an uncopied provider URI when MIME resolution fails; adopt it rather than lose the selected photo.
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

    await probe.serve('native.media.release', { handle: item?.handle ?? '' })
    expect(probe.discarded).toEqual([`${CACHE}/copy-0.bin`])
  })

  it('refuses a uri the copy could not adopt either, rather than minting over it', async () => {
    // Reject an unowned copy without deleting it or the provider’s source URI.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const probe = harness({
      copyIntoCache: (uri: string) => uri,
      launchLibrary: () =>
        Promise.resolve({
          canceled: false,
          assets: [{ uri: 'content://media/external/images/media/42', mimeType: 'image/jpeg' }]
        })
    })
    probe.files.set('content://media/external/images/media/42', bytesOf(64))
    await expect(
      probe.serve('native.media.pick', { source: 'library', multiple: false })
    ).rejects.toThrow(/this shell does not own/)
    expect(probe.registry.liveCount()).toBe(0)
    expect(probe.discarded).toEqual([])
    warn.mockRestore()
  })
})
