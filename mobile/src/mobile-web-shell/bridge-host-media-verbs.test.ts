import { Buffer } from 'node:buffer'
// Use the real bridge pair and serialization: media chunks approach the frame cap, where a direct handler call cannot reveal reply splitting.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_MEDIA_MAX_LIVE_HANDLES,
  BRIDGE_MEDIA_READ_MAX_BYTES,
  mediaPickResultSchema,
  mediaReadResultSchema
} from './bridge/bridge-media-verbs'
import {
  createFakeBridgePortPair,
  type BridgePortPair
} from './bridge/bridge-port-pair-test-harness'
import { MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from '../session/mobile-clipboard-image-upload-chunk'
import { MOBILE_WEB_SHELL_GRANTS } from './page-route-policy'
import { MEDIA_HANDLE_TTL_MS, MediaHandleRegistry } from './media-handle-registry'
import { createNativeMediaVerbServer, type NativeMediaFile } from '../platform/native-media'
import type { FakeRpcClient } from './bridge-host-test-fakes'

const CACHE = 'file:///cache'
const FIXTURE_BYTES = 18 * 1024 * 1024

function fixtureByte(index: number): number {
  return (index * 31 + 7) % 251
}

function fakeFile(byteLength: number): NativeMediaFile {
  return {
    size: byteLength,
    open: () => {
      let cursor = 0
      return {
        get offset(): number {
          return cursor
        },
        set offset(next: number | null) {
          cursor = next ?? 0
        },
        readBytes: (length: number) => {
          const end = Math.min(cursor + length, byteLength)
          const bytes = new Uint8Array(end - cursor)
          for (let index = 0; index < bytes.length; index += 1) {
            bytes[index] = fixtureByte(cursor + index)
          }
          cursor = end
          return bytes
        },
        close: () => {}
      }
    }
  }
}

type Pair = {
  pair: BridgePortPair<FakeRpcClient>
  registry: MediaHandleRegistry
  readonly picker: ReturnType<typeof vi.fn>
  readonly discarded: string[]
  advance: (ms: number) => void
}

const probes = new Set<Pair>()
afterEach(() => {
  for (const probe of probes) {
    probe.pair.client.close()
    probe.pair.host.dispose()
    probe.registry.releaseAll()
  }
  probes.clear()
})

function pairWith(options: { grants?: readonly string[]; byteLength?: number } = {}): Pair {
  const discarded: string[] = []
  let clock = 1_000
  const byteLength = options.byteLength ?? FIXTURE_BYTES
  const registry = new MediaHandleRegistry({
    now: () => clock,
    discard: (uri) => discarded.push(uri)
  })
  const picker = vi.fn(() =>
    Promise.resolve({
      canceled: false,
      assets: [{ uri: `${CACHE}/picked.png`, mimeType: 'image/png', width: 100, height: 80 }]
    })
  )
  const serveMedia = createNativeMediaVerbServer({
    registry,
    launchLibrary: picker,
    launchFiles: () => Promise.resolve({ canceled: true }),
    readClipboardImage: () => Promise.resolve(null),
    stageBase64: () => `${CACHE}/pasted.png`,
    openFile: () => fakeFile(byteLength),
    ownsStagedUri: (uri) => uri.startsWith('file:'),
    // Fixtures use file: URIs; keep an explicit dependency so an unexpected non-file path cannot go unobserved.
    copyIntoCache: (uri) => {
      throw new Error(`nothing in this suite picks a uri needing a copy: ${uri}`)
    },
    discard: (uri) => discarded.push(uri)
  })
  const pair = createFakeBridgePortPair({
    routeGrants: options.grants ?? MOBILE_WEB_SHELL_GRANTS,
    serveNativeVerb: (verb, params) => serveMedia(verb, params)
  })
  const probe: Pair = { pair, registry, picker, discarded, advance: (ms) => (clock += ms) }
  probes.add(probe)
  return probe
}

async function ready(pair: BridgePortPair<FakeRpcClient>): Promise<void> {
  pair.drainNow()
  await pair.flush()
}

describe('a granted page moving a picked image across the bridge', () => {
  it('picks, reads every chunk in order to eof, and releases', async () => {
    const probe = pairWith()
    await ready(probe.pair)

    const picked = mediaPickResultSchema.parse(
      (
        await probe.pair.client.callNativeVerb('native.media.pick', {
          source: 'library',
          multiple: false
        })
      ).result
    )
    expect(picked.items).toHaveLength(1)
    const item = picked.items[0]
    expect(item).toMatchObject({ mime: 'image/png', byteLength: FIXTURE_BYTES })
    const handle = item?.handle ?? ''

    let offset = 0
    let chunks = 0
    let decodedBytes = 0
    let eof = false
    const maxChunks = Math.ceil(FIXTURE_BYTES / BRIDGE_MEDIA_READ_MAX_BYTES) + 1
    for (; chunks < maxChunks;) {
      const chunk = mediaReadResultSchema.parse(
        (
          await probe.pair.client.callNativeVerb('native.media.read', {
            handle,
            offset,
            length: BRIDGE_MEDIA_READ_MAX_BYTES
          })
        ).result
      )
      const bytes = Buffer.from(chunk.base64, 'base64')
      expect(bytes.length).toBeGreaterThan(0)
      const expected = Uint8Array.from({ length: bytes.length }, (_, index) =>
        fixtureByte(offset + index)
      )
      expect(bytes.equals(expected), `chunk at byte ${offset}`).toBe(true)
      expect(chunk.base64.length).toBeLessThanOrEqual(
        MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
      )
      decodedBytes += bytes.length
      offset += bytes.length
      chunks += 1
      if (chunk.eof) {
        eof = true
        break
      }
    }
    expect(eof).toBe(true)
    expect(decodedBytes).toBe(FIXTURE_BYTES)
    expect(chunks).toBe(Math.ceil(FIXTURE_BYTES / BRIDGE_MEDIA_READ_MAX_BYTES))
    // Native media never forwards to desktop or uses split replies; inspect both paths to prove the serialized chunk fits.
    expect(probe.pair.rpc.requests).toEqual([])

    await expect(
      probe.pair.client.callNativeVerb('native.media.release', { handle })
    ).resolves.toMatchObject({ result: { released: true } })
    expect(probe.discarded).toEqual([`${CACHE}/picked.png`])
    expect(probe.registry.liveCount()).toBe(0)
  })
})

describe('a page that was not granted the verbs', () => {
  it('is refused by the host before the picker runs', async () => {
    const probe = pairWith({ grants: ['navigate', 'storage'] })
    await ready(probe.pair)
    const before = probe.pair.toShell.length
    await expect(
      probe.pair.client.callNativeVerb('native.media.pick', { source: 'library', multiple: false })
    ).rejects.toMatchObject({ code: 'native_verb_ungranted' })
    expect(probe.registry.liveCount()).toBe(0)
    expect(probe.picker).not.toHaveBeenCalled()
    expect(probe.pair.rpc.requests).toEqual([])
    // The frame left the page; assert the host’s refusal code rather than only lack of a handler call.
    expect(probe.pair.toShell.length).toBeGreaterThan(before)
  })
})

describe('a handle the page no longer has', () => {
  async function pickedHandle(probe: Pair): Promise<string> {
    const picked = mediaPickResultSchema.parse(
      (
        await probe.pair.client.callNativeVerb('native.media.pick', {
          source: 'library',
          multiple: false
        })
      ).result
    )
    return picked.items[0]?.handle ?? ''
  }

  it('refuses a chunk of one the page released', async () => {
    const probe = pairWith({ byteLength: 4096 })
    await ready(probe.pair)
    const handle = await pickedHandle(probe)
    await probe.pair.client.callNativeVerb('native.media.release', { handle })
    await expect(
      probe.pair.client.callNativeVerb('native.media.read', { handle, offset: 0, length: 16 })
    ).rejects.toMatchObject({ code: 'native_media_handle_unknown' })
  })

  it('refuses a chunk of one the TTL swept, and the file is gone with it', async () => {
    const probe = pairWith({ byteLength: 4096 })
    await ready(probe.pair)
    const handle = await pickedHandle(probe)
    expect(probe.discarded).toEqual([])
    probe.advance(MEDIA_HANDLE_TTL_MS + 1)
    await expect(
      probe.pair.client.callNativeVerb('native.media.read', { handle, offset: 0, length: 16 })
    ).rejects.toMatchObject({ code: 'native_media_handle_unknown' })
    expect(probe.discarded).toEqual([`${CACHE}/picked.png`])
  })

  it('refuses a read that starts past the end, which is what a page past eof asks for', async () => {
    const probe = pairWith({ byteLength: 4096 })
    await ready(probe.pair)
    const handle = await pickedHandle(probe)
    await expect(
      probe.pair.client.callNativeVerb('native.media.read', {
        handle,
        offset: 4096,
        length: 16
      })
    ).rejects.toMatchObject({ code: 'native_media_range' })
  })

  it('refuses a pick that would pass the live-handle cap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const probe = pairWith({ byteLength: 64 })
    await ready(probe.pair)
    for (let index = 0; index < BRIDGE_MEDIA_MAX_LIVE_HANDLES; index += 1) {
      await pickedHandle(probe)
    }
    await expect(
      probe.pair.client.callNativeVerb('native.media.pick', { source: 'library', multiple: false })
    ).rejects.toMatchObject({ code: 'native_media_handle_cap' })
    warn.mockRestore()
  })
})
