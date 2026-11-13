import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BRIDGE_MEDIA_MAX_LIVE_HANDLES,
  mediaPickResultSchema,
  mediaReadResultSchema
} from '../../mobile-web-shell/bridge/bridge-media-verbs'
import { readShellRefusalCode } from '../../mobile-web-shell/bridge-host-errors'
import { MediaHandleRegistry } from '../../mobile-web-shell/media-handle-registry'

import type { BridgeNativeVerb } from '../../mobile-web-shell/bridge/bridge-native-verbs'
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
        readBytesSync: (length: number) => {
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
