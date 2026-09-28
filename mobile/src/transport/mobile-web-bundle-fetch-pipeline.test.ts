import { sha256 } from '@noble/hashes/sha256'
import { describe, expect, it, vi } from 'vitest'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { fetchMobileWebBundle } from './mobile-web-bundle-fetch'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'
import { readMobileWebBundleErrorCode } from './mobile-web-bundle-operations'
import type { RpcClient } from './rpc-client'
import type { RpcResponse } from './types'

const CHUNK_BYTES = 4

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

type ChunkRequest = { path: string; offset: number }
type Reply = { error: string } | { result: unknown }

type WaveHostOptions = {
  /** Host-side read slots left for this client; the host refuses a read that arrives over it. */
  readSlots?: number
  /** Replaces the reply for one request. */
  intercept?: (request: ChunkRequest) => Reply | undefined
}

/**
 * A host whose chunk replies wait until the test releases them, a whole wave at a time. A wave is
 * one round trip: every read in flight when it is released answers together, so the number of
 * waves is the number of round trips on the critical path, with no clock involved.
 */
function waveHost(files: Record<string, string>, options: WaveHostOptions = {}) {
  const contents = new Map(Object.entries(files).map(([path, text]) => [path, bytesOf(text)]))
  const assets = [...contents.entries()]
    .map(([path, content]) => ({
      path,
      sha256: toHex(sha256(content)),
      byteLength: content.byteLength,
      contentType: 'text/plain'
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
  const requests: ChunkRequest[] = []
  const peaks: number[] = []
  let refusals = 0
  let inFlight = 0
  let waiting: (() => void)[] = []

  const answer = (request: ChunkRequest): Reply => {
    const content = contents.get(request.path)!
    const slice = content.subarray(request.offset, request.offset + CHUNK_BYTES)
    return {
      result: {
        buildId,
        path: request.path,
        offset: request.offset,
        assetByteLength: content.byteLength,
        sha256: toHex(sha256(content)),
        dataBase64: btoa(String.fromCharCode(...slice)),
        eof: request.offset + slice.byteLength >= content.byteLength
      }
    }
  }

  const respond = (reply: Reply): RpcResponse =>
    'error' in reply
      ? {
          id: 'rpc-1',
          ok: false,
          error: { code: 'invalid_argument', message: reply.error },
          _meta: { runtimeId: 'runtime-1' }
        }
      : { id: 'rpc-1', ok: true, result: reply.result, _meta: { runtimeId: 'runtime-1' } }

  const client: RpcClient = {
    sendRequest: vi.fn(async (method: string, params?: unknown): Promise<RpcResponse> => {
      if (method === 'mobileWeb.bundle.manifest') {
        return respond({ result: { manifest, chunkBytes: CHUNK_BYTES } })
      }
      const boxed: Record<string, unknown> = Object(params)
      const request = { path: String(boxed.path), offset: Number(boxed.offset) }
      requests.push(request)
      inFlight += 1
      peaks.push(inFlight)
      const refused = inFlight > (options.readSlots ?? 4)
      if (refused) {
        refusals += 1
      }
      await new Promise<void>((resolve) => waiting.push(resolve))
      inFlight -= 1
      if (refused) {
        return respond({ error: 'mobile_web_bundle_read_limited' })
      }
      return respond(options.intercept?.(request) ?? answer(request))
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

  const settleMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

  /** Releases wave after wave until `done` settles and returns how many waves that took, then keeps
   *  draining, so a read that should have been stopped is counted instead of left unreleased. */
  const runWaves = async (
    done: Promise<unknown>,
    beforeWave?: (wave: number) => void
  ): Promise<number> => {
    let settled = false
    done.then(
      () => (settled = true),
      () => (settled = true)
    )
    let waves = 0
    await settleMicrotasks()
    while (!settled && waiting.length > 0) {
      const wave = waiting
      waiting = []
      waves += 1
      beforeWave?.(waves)
      wave.forEach((release) => release())
      await settleMicrotasks()
    }
    while (waiting.length > 0) {
      const wave = waiting
      waiting = []
      wave.forEach((release) => release())
      await settleMicrotasks()
    }
    return waves
  }

  const refusalCount = () => refusals
  return { client, manifest, requests, peaks, refusalCount, runWaves }
}

/** One 71-chunk asset, the shape of the real bundle's largest script, behind five small ones. */
function syntheticBundle(): Record<string, string> {
  const big = Array.from({ length: 71 * CHUNK_BYTES - 1 }, (_, index) =>
    String.fromCharCode(97 + (index % 26))
  ).join('')
  return {
    'a.js': 'a1',
    'b.js': 'bb2',
    'c.js': 'ccc3',
    'd.js': 'd',
    'e.js': 'eee',
    'z-big.js': big
  }
}

describe('fetchMobileWebBundle chunk pipeline', () => {
  it('keeps four chunk reads in flight across the whole bundle, largest asset first', async () => {
    const files = syntheticBundle()
    const host = waveHost(files)

    const fetched = fetchMobileWebBundle({ client: host.client })
    const waves = await host.runWaves(fetched)
    const result = await fetched

    // 71 + 5 chunks at four per round trip is 19; one asset per reader was 1 + 71 = 72.
    expect(waves).toBe(19)
    expect(host.requests).toHaveLength(76)
    expect(host.requests.slice(0, 4)).toEqual([
      { path: 'z-big.js', offset: 0 },
      { path: 'z-big.js', offset: 4 },
      { path: 'z-big.js', offset: 8 },
      { path: 'z-big.js', offset: 12 }
    ])
    expect(Math.max(...host.peaks)).toBe(4)
    for (const [path, text] of Object.entries(files)) {
      expect(new TextDecoder().decode(result.assets.get(path))).toBe(text)
    }
  })

  it('fails the fetch on a read-limited refusal and stops the other reads', async () => {
    const host = waveHost(syntheticBundle(), { readSlots: 3 })

    const fetched = fetchMobileWebBundle({ client: host.client })
    await host.runWaves(fetched)
    const error = await fetched.catch((thrown: unknown) => thrown)

    expect(readMobileWebBundleErrorCode(error)).toBe('mobile_web_bundle_read_limited')
    expect(host.refusalCount()).toBe(1)
    // The first wave's four, plus one follow-up from each sibling reply that settled before the refusal.
    expect(host.requests.length).toBeLessThanOrEqual(7)
  })

  it('rejects a caller abort that lands during the final window', async () => {
    const controller = new AbortController()
    const host = waveHost(syntheticBundle())

    const fetched = fetchMobileWebBundle({ client: host.client, signal: controller.signal })
    const waves = await host.runWaves(fetched, (wave) => {
      if (wave === 19) {
        controller.abort()
      }
    })

    // Every read is already sent by the last wave, so no later dispatch can notice the abort.
    expect(waves).toBe(19)
    expect(host.requests).toHaveLength(76)
    const error = await fetched.catch((thrown: unknown) => thrown)
    expect(error instanceof MobileWebBundleFetchError ? error.refusal : null).toBe('fetch-stopped')
  })

  it('reports received bytes before the first asset completes', async () => {
    const host = waveHost(syntheticBundle())
    const progress: { completedAssets: number; receivedBytes: number }[] = []

    const fetched = fetchMobileWebBundle({
      client: host.client,
      onProgress: ({ completedAssets, receivedBytes }) =>
        progress.push({ completedAssets, receivedBytes })
    })
    await host.runWaves(fetched)
    await fetched

    expect(progress[0]).toEqual({ completedAssets: 0, receivedBytes: CHUNK_BYTES })
    expect(progress.at(-1)).toEqual({
      completedAssets: 6,
      receivedBytes: 71 * CHUNK_BYTES - 1 + 13
    })
  })

  it('stops every other read once one chunk fails', async () => {
    const host = waveHost(syntheticBundle(), {
      intercept: (request) =>
        request.path === 'z-big.js' && request.offset === 4
          ? { error: 'mobile_web_bundle_asset_unknown' }
          : undefined
    })

    const fetched = fetchMobileWebBundle({ client: host.client })
    await host.runWaves(fetched)
    const error = await fetched.catch((thrown: unknown) => thrown)

    expect(readMobileWebBundleErrorCode(error)).toBe('mobile_web_bundle_asset_unknown')
    // The first wave's four, plus at most the one its first sibling reply dispatched before the
    // failing reply settled.
    expect(host.requests.length).toBeLessThanOrEqual(5)
  })

  it('refuses a chunk short of its slot that does not end the asset', async () => {
    // Offsets are planned, not chained, so a short middle chunk would leave a hole.
    const host = waveHost(
      { 'index.html': 'abcdefghij' },
      {
        intercept: (request) =>
          request.offset === 0
            ? {
                result: {
                  buildId: host.manifest.buildId,
                  path: 'index.html',
                  offset: 0,
                  assetByteLength: 10,
                  sha256: host.manifest.assets[0]!.sha256,
                  dataBase64: btoa('ab'),
                  eof: false
                }
              }
            : undefined
      }
    )

    const fetched = fetchMobileWebBundle({ client: host.client })
    await host.runWaves(fetched)
    const error = await fetched.catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(MobileWebBundleFetchError)
    expect(error instanceof MobileWebBundleFetchError ? error.refusal : null).toBe('asset-short')
  })
})
