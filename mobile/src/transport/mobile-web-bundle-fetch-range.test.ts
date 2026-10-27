import { sha256 } from '@noble/hashes/sha256'
import { gzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { fetchMobileWebBundle } from './mobile-web-bundle-fetch'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'
import type { RpcClient } from './rpc-client'
import type { RpcResponse } from './types'

// Hashed before it resolves, as the native module's synchronous digest is.
vi.mock('expo-crypto', async () => {
  const { sha256: hash } = await import('@noble/hashes/sha256')
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digest: async (_algorithm: string, data: Uint8Array) => hash(data).buffer
  }
})

// Use smaller host-declared grids to exercise paging cheaply; desktop tests pin production sizes.
const RANGE_GRID = 4096
const CHUNK_GRID = 1024

type Inflation = { readonly outLength: number; readonly resultLength: number }
type LoggedInflation = Inflation & { readonly body: Uint8Array }

// Key inflation observations by body so late reads from earlier fetches cannot enter this host’s results.
const inflationLog = vi.hoisted((): LoggedInflation[] => [])

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

// Mirror host gzip-if-smaller range rules; omission of ranges models older chunk-only hosts.
function rangeHost(
  files: Record<string, Uint8Array>,
  options: { ranges?: boolean; tamper?: (call: HostCall, body: string) => string } = {}
) {
  const digests = new Map(
    Object.entries(files).map(([path, content]) => [path, toHex(sha256(content))])
  )
  const assets = Object.entries(files)
    .map(([path, content]) => ({
      path,
      sha256: digests.get(path)!,
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
        ? { manifest, chunkBytes: CHUNK_GRID }
        : {
            manifest,
            chunkBytes: CHUNK_GRID,
            rangeBytes: RANGE_GRID
          }
    }
    const path = String(call.params.path)
    const offset = Number(call.params.offset)
    const content = files[path]!
    const grid = call.method === 'mobileWeb.bundle.range' ? RANGE_GRID : CHUNK_GRID
    const slice = content.subarray(offset, offset + grid)
    const header = {
      buildId,
      path,
      offset,
      assetByteLength: content.byteLength,
      sha256: digests.get(path)!,
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
    inflations: (): Inflation[] =>
      inflationLog
        .filter((entry) => sentGzipBodies.has(encodeBase64(entry.body)))
        .map(({ outLength, resultLength }) => ({ outLength, resultLength }))
  }
}

const EXACT = 'assets/exact.js'
const NOISE = 'assets/noise.bin'
const EMPTY = 'assets/empty.txt'
const FILES: Record<string, Uint8Array> = {
  'assets/app.js': scriptBytes(RANGE_GRID * 2 + 500, 1),
  [EXACT]: scriptBytes(RANGE_GRID * 2, 4),
  [NOISE]: noiseBytes(3000),
  [EMPTY]: new Uint8Array(0),
  'index.html': scriptBytes(600, 3)
}

function readsOf(calls: readonly HostCall[], method: string): HostCall[] {
  return calls.filter((call) => call.method === method)
}

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
    expect(ranges).toHaveLength(slotsOn(RANGE_GRID))
    for (const range of ranges) {
      expect(Object.keys(range.params).sort()).toEqual(['buildId', 'offset', 'path'])
      expect(Number(range.params.offset) % RANGE_GRID).toBe(0)
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
    expect(exact.map((call) => call.params.offset)).toEqual([0, RANGE_GRID])
  })

  it('pages a host whose manifest names no range grid in chunks, as before', async () => {
    const host = rangeHost(FILES, { ranges: false })
    const fetched = await fetchMobileWebBundle({ client: host.client })

    expect(fetched.assets.get('assets/app.js')).toEqual(FILES['assets/app.js'])
    expect(readsOf(host.calls, 'mobileWeb.bundle.range')).toHaveLength(0)
    expect(readsOf(host.calls, 'mobileWeb.bundle.chunk')).toHaveLength(slotsOn(CHUNK_GRID))
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

  // Bound a gzip bomb at one byte over its slot; enough planned reads expose continued dispatch after refusal.
  it('refuses a gzip bomb at one byte over the window and sends little after it', async () => {
    vi.useFakeTimers()
    try {
      const bomb = encodeBase64(gzipSync(new Uint8Array(4 * 1024 * 1024), { level: 9 }))
      const many = Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [
          `assets/part-${String(index)}.js`,
          scriptBytes(RANGE_GRID * 2, index)
        ])
      )
      const host = rangeHost(many, {
        tamper: (call, body) =>
          call.params.path === 'assets/part-0.js' && call.params.offset === 0 ? bomb : body
      })

      const refusal = refusalOf(fetchMobileWebBundle({ client: host.client }))
      await vi.runAllTimersAsync()
      expect(await refusal).toBe('chunk-oversize')
      const window = RANGE_GRID + 1
      expect(host.inflations().filter((inflation) => inflation.resultLength === window)).toEqual([
        { outLength: window, resultLength: window }
      ])
      // Sibling stop permits only in-flight work and immediate follow-ups, never the full planned grid.
      expect(readsOf(host.calls, 'mobileWeb.bundle.range').length).toBeLessThanOrEqual(8)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a range that inflates short of its window as short', async () => {
    const host = rangeHost(FILES, {
      tamper: (call, body) =>
        call.params.path === 'index.html' ? encodeBase64(gzipSync(scriptBytes(599, 3))) : body
    })

    expect(await refusalOf(fetchMobileWebBundle({ client: host.client }))).toBe('asset-short')
  })
})
