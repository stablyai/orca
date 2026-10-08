/**
 * The media verbs over the real pair: a page that picks, reads to `eof` and releases, and every
 * refusal it gets for a handle it no longer has.
 *
 * Through `createFakeBridgePortPair` rather than the host alone, because a chunk is the one reply
 * this seam produces that is within a rounding error of the frame cap: a case that called the
 * server directly would never serialize one, and serializing is where a reply that fits and a
 * reply that splits part ways.
 */
import { describe, expect, it, vi } from 'vitest'
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
import { BRIDGE_NATIVE_VERBS } from './bridge/bridge-native-verbs'
import { MOBILE_WEB_SHELL_GRANTS } from './page-route-policy'
import { MEDIA_HANDLE_TTL_MS, MediaHandleRegistry } from './media-handle-registry'
import { createNativeMediaVerbServer, type NativeMediaFile } from '../platform/native-media'
import type { FakeRpcClient } from './bridge-host-test-fakes'

const CACHE = 'file:///cache'
/** The largest item the design's picked image reaches, which is what a real pick has to carry. */
const FIXTURE_BYTES = 18 * 1024 * 1024

/** A deterministic body, cheap to build and cheap to compare a chunk of. */
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
  readonly discarded: string[]
  advance: (ms: number) => void
}

function pairWith(options: { grants?: readonly string[]; byteLength?: number } = {}): Pair {
  const discarded: string[] = []
  let clock = 1_000
  const byteLength = options.byteLength ?? FIXTURE_BYTES
  const registry = new MediaHandleRegistry({
    now: () => clock,
    discard: (uri) => discarded.push(uri)
  })
  const serveMedia = createNativeMediaVerbServer({
    registry,
    launchLibrary: () =>
      Promise.resolve({
        canceled: false,
        assets: [{ uri: `${CACHE}/picked.png`, mimeType: 'image/png', width: 100, height: 80 }]
      }),
    launchFiles: () => Promise.resolve({ canceled: true }),
    readClipboardImage: () => Promise.resolve(null),
    stageBase64: () => `${CACHE}/pasted.png`,
    openFile: () => fakeFile(byteLength),
    ownsStagedUri: (uri) => uri.startsWith('file:'),
    // The pair's fixtures all answer a `file:` uri, so this is never reached; it is here because
    // a dep the harness leaves out is one the suite cannot say anything about.
    copyIntoCache: (uri) => {
      throw new Error(`nothing in this suite picks a uri needing a copy: ${uri}`)
    },
    discard: (uri) => discarded.push(uri)
  })
  const pair = createFakeBridgePortPair({
    routeGrants: options.grants ?? MOBILE_WEB_SHELL_GRANTS,
    serveNativeVerb: (verb, params) => serveMedia(verb, params)
  })
  return { pair, registry, discarded, advance: (ms) => (clock += ms) }
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
    let firstByte: number | null = null
    let lastByte: number | null = null
    for (;;) {
      const chunk = mediaReadResultSchema.parse(
        (
          await probe.pair.client.callNativeVerb('native.media.read', {
            handle,
            offset,
            length: BRIDGE_MEDIA_READ_MAX_BYTES
          })
        ).result
      )
      const bytes = atob(chunk.base64)
      firstByte ??= bytes.codePointAt(0) ?? null
      lastByte = bytes.codePointAt(bytes.length - 1) ?? null
      decodedBytes += bytes.length
      offset += bytes.length
      chunks += 1
      if (chunk.eof) {
        break
      }
    }
    // Every byte, in order, and no chunk skipped: the count is the file's own length and the
    // ends are the fixture's, which a reader that dropped or reordered a chunk would not have.
    expect(decodedBytes).toBe(FIXTURE_BYTES)
    expect(chunks).toBe(Math.ceil(FIXTURE_BYTES / BRIDGE_MEDIA_READ_MAX_BYTES))
    expect(firstByte).toBe(fixtureByte(0))
    expect(lastByte).toBe(fixtureByte(FIXTURE_BYTES - 1))
    // Not one frame of this crossed as a forwarded request: a `native.` method never reaches the
    // desktop, and a chunked reply would say so here as a split the page had to reassemble.
    expect(probe.pair.rpc.requests).toEqual([])

    await expect(
      probe.pair.client.callNativeVerb('native.media.release', { handle })
    ).resolves.toMatchObject({ result: { released: true } })
    expect(probe.discarded).toEqual([`${CACHE}/picked.png`])
    expect(probe.registry.liveCount()).toBe(0)
  })
})

describe('a page that was not granted the verbs', () => {
  it('is refused at the call site, with no frame sent and no picker run', async () => {
    const probe = pairWith({ grants: ['navigate', 'storage'] })
    await ready(probe.pair)
    const before = probe.pair.toShell.length
    await expect(
      probe.pair.client.callNativeVerb('native.media.pick', { source: 'library', multiple: false })
    ).rejects.toMatchObject({ code: 'native_verb_ungranted' })
    expect(probe.registry.liveCount()).toBe(0)
    expect(probe.pair.rpc.requests).toEqual([])
    // A frame did leave — the page side of these verbs is C7.6's — so the oracle is the code,
    // and that the host decided it rather than a handler.
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

describe('the pair every other suite gets by default', () => {
  it('answers each verb a shape its own table declares, so a case can call one and read it', async () => {
    // Without this the default handler answers a clipboard shape for every verb, and a media call
    // through an unconfigured pair comes back as `native_verb_result` — a shell bug's code for a
    // harness that was never told about the verb.
    const pair = createFakeBridgePortPair()
    await ready(pair)
    for (const [verb, params] of [
      ['native.media.pick', { source: 'library', multiple: false }],
      ['native.media.read', { handle: 'media-1', offset: 0, length: 16 }],
      ['native.media.release', { handle: 'media-1' }]
    ] as const) {
      const reply = await pair.client.callNativeVerb(verb, params)
      expect(BRIDGE_NATIVE_VERBS[verb].result.safeParse(reply.result).success, verb).toBe(true)
    }
  })
})
