import { sha256 } from '@noble/hashes/sha256'
import { gzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_CHUNK_BYTES,
  MOBILE_WEB_BUNDLE_RANGE_BYTES
} from '../../../src/shared/mobile-web-bundle/bundle-rpc-contract'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { fetchMobileWebBundle } from './mobile-web-bundle-fetch'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'
import type { RpcClient } from './rpc-client'
import type { RpcResponse } from './types'

type Inflation = { readonly outLength: number; readonly resultLength: number }

/** Every inflation in the process, keyed by the gzip body it was handed; a host reads back only
 *  the bodies it sent, so a read left running by an earlier test's fetch never lands in its sink. */
const inflationLog = vi.hoisted(
  () => [] as { body: Uint8Array; outLength: number; resultLength: number }[]
)

// Observes the bound the decoder hands fflate, and what fflate hands back inside it.
vi.mock('fflate', async (importOriginal) => {
  const fflate = await importOriginal<typeof import('fflate')>()
  return {
    ...fflate,
    gunzipSync: (data: Uint8Array, options?: { out?: Uint8Array }) => {
      const result = fflate.gunzipSync(data, options)
      inflationLog.push({
        body: data,
        outLength: options?.out?.byteLength ?? -1,
        resultLength: result.byteLength
      })
      return result
    }
  }
})

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/** Script-like: repetitive enough to gzip well, varied enough that a misplaced window shows. */
function scriptBytes(byteLength: number, seed: number): Uint8Array {
  return Uint8Array.from({ length: byteLength }, (_, index) =>
    index % 97 === 0 ? (seed + index / 97) % 256 : 97 + ((index * 7 + seed) % 26)
  )
}

/** Deterministic and incompressible, so the host sends it as identity. */
function noiseBytes(byteLength: number): Uint8Array {
  let state = 0x9e3779b9
  return Uint8Array.from({ length: byteLength }, () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state & 0xff
  })
}

type HostCall = { method: string; params: Record<string, unknown> }

/**
 * A host that serves both read methods by the real one's rules: ranges on its advertised grid,
 * gzipped at level 6 when that shrinks them. `ranges: false` is a host that predates the method.
 * `tamper` replaces the body of one range reply.
 */
function rangeHost(
  files: Record<string, Uint8Array>,
  options: { ranges?: boolean; tamper?: (call: HostCall, body: string) => string } = {}
) {
  const assets = Object.entries(files)
    .map(([path, content]) => ({
      path,
      sha256: toHex(sha256(content)),
      byteLength: content.byteLength,
      contentType: 'text/javascript'
    }))
    .sort((left, right) => (left.path < right.path ? -1 : 1))
  const buildId = computeMobileWebBundleId(assets)
  const manifest = {
    schemaVersion: 1,
    buildId,
    desktopVersion: '1.4.200',
    minCompatibleRuntimeProtocolVersion: 2,
    runtimeProtocolVersion: 2,
    entrypoint: assets[0]!.path,
    totalBytes: assets.reduce((total, entry) => total + entry.byteLength, 0),
    assets
  }
  const calls: HostCall[] = []
  const sentGzipBodies = new Set<string>()
  let wireBase64Bytes = 0
  let inFlight = 0
  let peakInFlight = 0

  const answer = (call: HostCall): unknown => {
    if (call.method === 'mobileWeb.bundle.manifest') {
      return options.ranges === false
        ? { manifest, chunkBytes: MOBILE_WEB_BUNDLE_CHUNK_BYTES }
        : {
            manifest,
            chunkBytes: MOBILE_WEB_BUNDLE_CHUNK_BYTES,
            rangeBytes: MOBILE_WEB_BUNDLE_RANGE_BYTES
          }
    }
    const path = String(call.params.path)
    const offset = Number(call.params.offset)
    const content = files[path]!
    const grid =
      call.method === 'mobileWeb.bundle.range'
        ? MOBILE_WEB_BUNDLE_RANGE_BYTES
        : MOBILE_WEB_BUNDLE_CHUNK_BYTES
    const slice = content.subarray(offset, offset + grid)
    const header = {
      buildId,
      path,
      offset,
      assetByteLength: content.byteLength,
      sha256: toHex(sha256(content)),
      eof: offset + slice.byteLength >= content.byteLength
    }
    if (call.method === 'mobileWeb.bundle.chunk') {
      return { ...header, dataBase64: encodeBase64(slice) }
    }
    const gzipped = gzipSync(slice, { level: 6 })
    const encoding = gzipped.byteLength < slice.byteLength ? 'gzip' : 'identity'
    const body = encodeBase64(encoding === 'gzip' ? gzipped : slice)
    const dataBase64 = options.tamper?.(call, body) ?? body
    if (encoding === 'gzip') {
      sentGzipBodies.add(dataBase64)
    }
    return { ...header, encoding, dataBase64 }
  }

  const client: RpcClient = {
    sendRequest: vi.fn(async (method: string, params?: unknown): Promise<RpcResponse> => {
      const call: HostCall = { method, params: Object(params) }
      calls.push(call)
      inFlight += 1
      peakInFlight = Math.max(peakInFlight, inFlight)
      try {
        await new Promise((resolve) => setTimeout(resolve, 0))
        const result = answer(call)
        const body: unknown = Object(result).dataBase64
        wireBase64Bytes += typeof body === 'string' ? body.length : 0
        return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
      } finally {
        inFlight -= 1
      }
    }),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: vi.fn(),
    close: vi.fn()
  }
  return {
    client,
    calls,
    wireBase64Bytes: () => wireBase64Bytes,
    peakInFlight: () => peakInFlight,
    /** Waits until nothing is in flight and nothing new was sent for a few ticks, so a read a
     *  missing sibling stop would still send is counted instead of left pending. */
    drain: async (): Promise<void> => {
      let quiet = 0
      for (let tick = 0; tick < 2000 && quiet < 10; tick += 1) {
        const sent = calls.length
        await new Promise((resolve) => setTimeout(resolve, 0))
        quiet = inFlight === 0 && calls.length === sent ? quiet + 1 : 0
      }
    },
    /** This host's inflations only: those whose body is one it sent. */
    inflations: (): Inflation[] =>
      inflationLog
        .filter((entry) => sentGzipBodies.has(encodeBase64(entry.body)))
        .map(({ outLength, resultLength }) => ({ outLength, resultLength }))
  }
}

const EXACT = 'assets/exact.js'
const NOISE = 'assets/noise.bin'
const EMPTY = 'assets/empty.txt'
/** One asset over a range, one an exact multiple of it, one incompressible, one empty. */
const FILES: Record<string, Uint8Array> = {
  'assets/app.js': scriptBytes(MOBILE_WEB_BUNDLE_RANGE_BYTES * 2 + 5000, 1),
  [EXACT]: scriptBytes(MOBILE_WEB_BUNDLE_RANGE_BYTES * 2, 4),
  [NOISE]: noiseBytes(70_000),
  [EMPTY]: new Uint8Array(0),
  'index.html': scriptBytes(600, 3)
}

function readsOf(calls: readonly HostCall[], method: string): HostCall[] {
  return calls.filter((call) => call.method === method)
}

/** One read per grid slot, and one for an empty asset. */
function slotsOn(grid: number, files: Record<string, Uint8Array> = FILES): number {
  return Object.values(files).reduce(
    (total, file) => total + Math.max(1, Math.ceil(file.byteLength / grid)),
    0
  )
}

async function refusalOf(failed: Promise<unknown>): Promise<string | null> {
  const error = await failed.then(
    () => null,
    (thrown: unknown) => thrown
  )
  return error instanceof MobileWebBundleFetchError ? error.refusal : null
}

describe('fetchMobileWebBundle from a host whose manifest names a range grid', () => {
  it('pages every asset in ranges on that grid and returns the verified bytes', async () => {
    const host = rangeHost(FILES)
    const fetched = await fetchMobileWebBundle({ client: host.client })

    for (const [path, content] of Object.entries(FILES)) {
      expect(fetched.assets.get(path)).toEqual(content)
    }
    expect(readsOf(host.calls, 'mobileWeb.bundle.chunk')).toHaveLength(0)
    const ranges = readsOf(host.calls, 'mobileWeb.bundle.range')
    expect(ranges).toHaveLength(slotsOn(MOBILE_WEB_BUNDLE_RANGE_BYTES))
    for (const range of ranges) {
      expect(Object.keys(range.params).sort()).toEqual(['buildId', 'offset', 'path'])
      expect(Number(range.params.offset) % MOBILE_WEB_BUNDLE_RANGE_BYTES).toBe(0)
    }
    expect(host.peakInFlight()).toBe(4)
  })

  it('accepts an identity range, an empty asset, and an asset that ends on the grid', async () => {
    const host = rangeHost(FILES)
    const fetched = await fetchMobileWebBundle({ client: host.client })

    expect(fetched.assets.get(NOISE)).toEqual(FILES[NOISE])
    expect(fetched.assets.get(EMPTY)).toEqual(new Uint8Array(0))
    expect(fetched.assets.get(EXACT)).toEqual(FILES[EXACT])
    const exact = readsOf(host.calls, 'mobileWeb.bundle.range').filter(
      (call) => call.params.path === EXACT
    )
    expect(exact.map((call) => call.params.offset)).toEqual([0, MOBILE_WEB_BUNDLE_RANGE_BYTES])
  })

  it('pages a host whose manifest names no range grid in chunks, as before', async () => {
    const host = rangeHost(FILES, { ranges: false })
    const fetched = await fetchMobileWebBundle({ client: host.client })

    expect(fetched.assets.get('assets/app.js')).toEqual(FILES['assets/app.js'])
    expect(readsOf(host.calls, 'mobileWeb.bundle.range')).toHaveLength(0)
    expect(readsOf(host.calls, 'mobileWeb.bundle.chunk')).toHaveLength(
      slotsOn(MOBILE_WEB_BUNDLE_CHUNK_BYTES)
    )
  })

  it('carries the same bundle in fewer reads and fewer bytes than chunks', async () => {
    const chunked = rangeHost(FILES, { ranges: false })
    const ranged = rangeHost(FILES)
    await fetchMobileWebBundle({ client: chunked.client })
    await fetchMobileWebBundle({ client: ranged.client })

    expect(readsOf(ranged.calls, 'mobileWeb.bundle.range').length).toBeLessThan(
      readsOf(chunked.calls, 'mobileWeb.bundle.chunk').length
    )
    expect(ranged.wireBase64Bytes()).toBeLessThan(chunked.wireBase64Bytes())
  })

  it('refuses a corrupt gzip range as undecodable', async () => {
    const host = rangeHost(FILES, {
      tamper: (call, body) =>
        call.params.path === 'assets/app.js' && call.params.offset === 0
          ? encodeBase64(Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3))
          : body
    })

    expect(await refusalOf(fetchMobileWebBundle({ client: host.client }))).toBe('range-undecodable')
  })

  // A 4 MiB inflation answering the first 384 KiB window: fflate fills the bounded buffer and stops
  // there. Twenty reads are planned, so a fetch that kept going after the refusal is visible.
  it('refuses a gzip bomb at one byte over the window and sends little after it', async () => {
    const bomb = encodeBase64(gzipSync(new Uint8Array(4 * 1024 * 1024), { level: 9 }))
    const many = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `assets/part-${String(index)}.js`,
        scriptBytes(MOBILE_WEB_BUNDLE_RANGE_BYTES * 2, index)
      ])
    )
    const host = rangeHost(many, {
      tamper: (call, body) =>
        call.params.path === 'assets/part-0.js' && call.params.offset === 0 ? bomb : body
    })

    expect(await refusalOf(fetchMobileWebBundle({ client: host.client }))).toBe('chunk-oversize')
    await host.drain()
    const window = MOBILE_WEB_BUNDLE_RANGE_BYTES + 1
    // Exactly one body filled the spare byte: the bomb, stopped there.
    expect(host.inflations().filter((inflation) => inflation.resultLength === window)).toEqual([
      { outLength: window, resultLength: window }
    ])
    // The sibling stop: at most the four in flight and one more each, never all twenty.
    expect(readsOf(host.calls, 'mobileWeb.bundle.range').length).toBeLessThanOrEqual(8)
  })

  it('refuses a range that inflates short of its window as short', async () => {
    const host = rangeHost(FILES, {
      tamper: (call, body) =>
        call.params.path === 'index.html' ? encodeBase64(gzipSync(scriptBytes(599, 3))) : body
    })

    expect(await refusalOf(fetchMobileWebBundle({ client: host.client }))).toBe('asset-short')
  })
})
