import { sha256 } from '@noble/hashes/sha256'
import { describe, expect, it, vi } from 'vitest'
import { fetchMobileWebBundle } from './mobile-web-bundle-fetch'
import { readMobileWebBundleErrorCode } from './mobile-web-bundle-operations'
import type { RpcClient } from './rpc-client'
import type { RpcResponse } from './types'

const BUILD_ID = 'a'.repeat(64)

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

type HostCall = { method: string; params: unknown }

type HostOptions = {
  chunkBytes?: number
  buildId?: string
  /** Replaces the reply the host would have sent for this request. */
  intercept?: (call: HostCall) => unknown
  onInFlight?: (inFlight: number) => void
}

/** Box first, so params that are not an object read as absent instead of throwing. */
function paramField(params: unknown, key: string): unknown {
  const boxed: Record<string, unknown> = Object(params)
  return boxed[key]
}

/** A host that serves a fixed asset table by the same rules the real one does. */
function bundleHost(files: Record<string, string>, options: HostOptions = {}) {
  const chunkBytes = options.chunkBytes ?? 4
  const buildId = options.buildId ?? BUILD_ID
  const bytes = new Map(Object.entries(files).map(([path, text]) => [path, bytesOf(text)]))
  const assets = [...bytes.entries()]
    .map(([path, content]) => ({
      path,
      sha256: toHex(sha256(content)),
      byteLength: content.byteLength,
      contentType: 'text/plain'
    }))
    .sort((left, right) => (left.path < right.path ? -1 : 1))
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
  let inFlight = 0

  const answer = (method: string, params: unknown): unknown => {
    if (method === 'mobileWeb.bundle.manifest') {
      return { manifest, chunkBytes }
    }
    const path = String(paramField(params, 'path'))
    const offset = Number(paramField(params, 'offset'))
    const content = bytes.get(path)!
    const slice = content.subarray(offset, offset + chunkBytes)
    return {
      buildId,
      path,
      offset,
      assetByteLength: content.byteLength,
      sha256: toHex(sha256(content)),
      dataBase64: encodeBase64(slice),
      eof: offset + slice.byteLength >= content.byteLength
    }
  }

  const client: RpcClient = {
    sendRequest: vi.fn(async (method: string, params?: unknown): Promise<RpcResponse> => {
      const call: HostCall = { method, params: params ?? {} }
      calls.push(call)
      inFlight += 1
      options.onInFlight?.(inFlight)
      try {
        await new Promise((resolve) => setTimeout(resolve, 0))
        const replaced = options.intercept?.(call)
        const result = replaced === undefined ? answer(method, call.params) : replaced
        if (result instanceof Error) {
          return {
            id: 'rpc-1',
            ok: false,
            error: { code: 'invalid_argument', message: result.message },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
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
  return { client, calls, manifest }
}

function chunkCallCount(calls: readonly HostCall[]): number {
  return calls.filter((call) => call.method === 'mobileWeb.bundle.chunk').length
}

/** Long enough for an unstopped worker pool to page three 40-byte assets one byte at a time. */
async function drainPendingHostWork(): Promise<void> {
  for (let tick = 0; tick < 300; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('fetchMobileWebBundle', () => {
  it('pages every asset to eof and returns the verified bytes', async () => {
    const host = bundleHost({ 'index.html': '<h1>orca</h1>', 'assets/app.js': 'x=1' })
    const progress: number[] = []

    const fetched = await fetchMobileWebBundle({
      client: host.client,
      onProgress: (update) => progress.push(update.receivedBytes)
    })

    expect([...fetched.assets.keys()].sort()).toEqual(['assets/app.js', 'index.html'])
    expect(new TextDecoder().decode(fetched.assets.get('index.html'))).toBe('<h1>orca</h1>')
    expect(new TextDecoder().decode(fetched.assets.get('assets/app.js'))).toBe('x=1')
    expect(fetched.totalBytes).toBe(16)
    expect(fetched.manifest.buildId).toBe(BUILD_ID)
    expect(fetched.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(progress).toHaveLength(2)
    expect(progress.at(-1)).toBe(16)
    // 13 bytes at 4 per chunk is four requests, 3 bytes is one, plus the manifest.
    expect(host.calls.filter((call) => call.method === 'mobileWeb.bundle.chunk')).toHaveLength(5)
    expect(host.calls[0]!.method).toBe('mobileWeb.bundle.manifest')
    expect(host.calls[0]!.params).toEqual({})
  })

  it('asks for each chunk at the offset the previous reply ended on', async () => {
    const host = bundleHost({ 'index.html': 'abcdefghij' }, { chunkBytes: 3 })

    await fetchMobileWebBundle({ client: host.client })

    expect(
      host.calls
        .filter((call) => call.method === 'mobileWeb.bundle.chunk')
        .map((call) => call.params)
    ).toEqual([
      { buildId: BUILD_ID, path: 'index.html', offset: 0 },
      { buildId: BUILD_ID, path: 'index.html', offset: 3 },
      { buildId: BUILD_ID, path: 'index.html', offset: 6 },
      { buildId: BUILD_ID, path: 'index.html', offset: 9 }
    ])
  })

  it('fails when a reassembled asset does not hash to the manifest entry', async () => {
    const host = bundleHost(
      { 'index.html': 'abcdef' },
      {
        chunkBytes: 3,
        intercept: (call) =>
          call.method === 'mobileWeb.bundle.chunk' && paramField(call.params, 'offset') === 3
            ? {
                buildId: BUILD_ID,
                path: 'index.html',
                offset: 3,
                assetByteLength: 6,
                sha256: toHex(sha256(bytesOf('abcdef'))),
                dataBase64: encodeBase64(bytesOf('XYZ')),
                eof: true
              }
            : undefined
      }
    )

    await expect(fetchMobileWebBundle({ client: host.client })).rejects.toThrow(
      /index\.html hashed [0-9a-f]{64}, not/
    )
  })

  it('fails when the host serves a later chunk from a different build', async () => {
    const host = bundleHost(
      { 'index.html': 'abcdef' },
      {
        chunkBytes: 3,
        intercept: (call) =>
          call.method === 'mobileWeb.bundle.chunk' && paramField(call.params, 'offset') === 3
            ? {
                buildId: 'c'.repeat(64),
                path: 'index.html',
                offset: 3,
                assetByteLength: 6,
                sha256: toHex(sha256(bytesOf('abcdef'))),
                dataBase64: encodeBase64(bytesOf('def')),
                eof: true
              }
            : undefined
      }
    )

    await expect(fetchMobileWebBundle({ client: host.client })).rejects.toThrow(
      'bundle build changed mid-fetch'
    )
  })

  it('refuses a chunk that answers a different path or offset', async () => {
    const host = bundleHost(
      { 'index.html': 'abc' },
      {
        intercept: (call) =>
          call.method === 'mobileWeb.bundle.chunk'
            ? {
                buildId: BUILD_ID,
                path: 'other.html',
                offset: 0,
                assetByteLength: 3,
                sha256: toHex(sha256(bytesOf('abc'))),
                dataBase64: encodeBase64(bytesOf('abc')),
                eof: true
              }
            : undefined
      }
    )

    await expect(fetchMobileWebBundle({ client: host.client })).rejects.toThrow(
      'bundle chunk answered other.html at 0, not index.html at 0'
    )
  })

  it('refuses a chunk that answers the right path at the wrong offset', async () => {
    // The path half of the echo check is already covered; this is the offset half on its own, so
    // a host that re-serves chunk zero cannot have its bytes written at the offset we asked for.
    const host = bundleHost(
      { 'index.html': 'abcdef' },
      {
        chunkBytes: 3,
        intercept: (call) =>
          call.method === 'mobileWeb.bundle.chunk' && paramField(call.params, 'offset') === 3
            ? {
                buildId: BUILD_ID,
                path: 'index.html',
                offset: 0,
                assetByteLength: 6,
                sha256: toHex(sha256(bytesOf('abcdef'))),
                dataBase64: encodeBase64(bytesOf('abc')),
                eof: false
              }
            : undefined
      }
    )

    await expect(fetchMobileWebBundle({ client: host.client })).rejects.toThrow(
      'bundle chunk answered index.html at 0, not index.html at 3'
    )
  })

  it('reads a zero-byte asset in one chunk and returns it empty', async () => {
    // A real bundle carries these. The asset is whole the moment the host says eof, and nothing
    // else in the loop can end it: a zero-length reply is otherwise how a host makes no progress.
    const host = bundleHost({ 'assets/empty.css': '', 'index.html': 'abc' })

    const fetched = await fetchMobileWebBundle({ client: host.client })

    expect(fetched.assets.get('assets/empty.css')).toEqual(new Uint8Array(0))
    expect(fetched.totalBytes).toBe(3)
    expect(
      host.calls.filter(
        (call) =>
          call.method === 'mobileWeb.bundle.chunk' &&
          paramField(call.params, 'path') === 'assets/empty.css'
      )
    ).toHaveLength(1)
  })

  it('never puts a fifth chunk request on one connection', async () => {
    const peaks: number[] = []
    const host = bundleHost(
      Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`assets/${index}.js`, `body-${index}`])
      ),
      { chunkBytes: 2, onInFlight: (inFlight) => peaks.push(inFlight) }
    )

    const fetched = await fetchMobileWebBundle({ client: host.client })

    expect(fetched.assets.size).toBe(9)
    expect(Math.max(...peaks)).toBe(4)
  })

  it('stops as soon as the caller aborts', async () => {
    const controller = new AbortController()
    const host = bundleHost({ 'index.html': 'abcdefgh' }, { chunkBytes: 2 })

    const started = fetchMobileWebBundle({ client: host.client, signal: controller.signal })
    controller.abort()

    await expect(started).rejects.toThrow('mobile web bundle fetch aborted')
    expect(host.calls.filter((call) => call.method === 'mobileWeb.bundle.chunk')).toHaveLength(0)
  })

  it('refuses a chunk larger than the size the host advertised', async () => {
    const host = bundleHost(
      { 'index.html': 'abcdef' },
      {
        chunkBytes: 3,
        intercept: (call) =>
          call.method === 'mobileWeb.bundle.chunk'
            ? {
                buildId: BUILD_ID,
                path: 'index.html',
                offset: 0,
                assetByteLength: 6,
                sha256: toHex(sha256(bytesOf('abcdef'))),
                dataBase64: encodeBase64(bytesOf('abcdef')),
                eof: true
              }
            : undefined
      }
    )

    await expect(fetchMobileWebBundle({ client: host.client })).rejects.toThrow(
      "bundle chunk for index.html at 0 is 6 bytes, over the host's 3"
    )
  })

  it('refuses a chunk whose asset no longer matches the manifest entry', async () => {
    const host = bundleHost(
      { 'index.html': 'abc' },
      {
        intercept: (call) =>
          call.method === 'mobileWeb.bundle.chunk'
            ? {
                buildId: BUILD_ID,
                path: 'index.html',
                offset: 0,
                assetByteLength: 4,
                sha256: toHex(sha256(bytesOf('abc'))),
                dataBase64: encodeBase64(bytesOf('abc')),
                eof: true
              }
            : undefined
      }
    )

    await expect(fetchMobileWebBundle({ client: host.client })).rejects.toThrow(
      'bundle asset index.html no longer matches the manifest entry'
    )
  })

  it('refuses an asset that ends short of the length the manifest declares', async () => {
    const host = bundleHost(
      { 'index.html': 'abcdef' },
      {
        chunkBytes: 3,
        intercept: (call) =>
          call.method === 'mobileWeb.bundle.chunk'
            ? {
                buildId: BUILD_ID,
                path: 'index.html',
                offset: 0,
                assetByteLength: 6,
                sha256: toHex(sha256(bytesOf('abcdef'))),
                dataBase64: encodeBase64(bytesOf('abc')),
                eof: true
              }
            : undefined
      }
    )

    await expect(fetchMobileWebBundle({ client: host.client })).rejects.toThrow(
      'bundle asset index.html ended at 3 of 6 declared bytes'
    )
  })

  it('stops a host that pages forever without sending a byte', async () => {
    const host = bundleHost(
      { 'index.html': 'abcdef' },
      {
        chunkBytes: 3,
        intercept: (call) =>
          call.method === 'mobileWeb.bundle.chunk'
            ? {
                buildId: BUILD_ID,
                path: 'index.html',
                offset: 0,
                assetByteLength: 6,
                sha256: toHex(sha256(bytesOf('abcdef'))),
                dataBase64: '',
                eof: false
              }
            : undefined
      }
    )

    await expect(fetchMobileWebBundle({ client: host.client })).rejects.toThrow(
      'bundle asset index.html made no progress at 0'
    )
  })

  it('stops the other workers mid-asset once one asset is refused', async () => {
    const host = bundleHost(
      {
        'a.js': 'x',
        'b.js': 'b'.repeat(40),
        'c.js': 'c'.repeat(40),
        'd.js': 'd'.repeat(40)
      },
      {
        chunkBytes: 1,
        intercept: (call) =>
          call.method === 'mobileWeb.bundle.chunk' && paramField(call.params, 'path') === 'a.js'
            ? new Error('mobile_web_bundle_asset_unknown')
            : undefined
      }
    )

    const error = await fetchMobileWebBundle({ client: host.client }).catch(
      (thrown: unknown) => thrown
    )
    const atRejection = chunkCallCount(host.calls)
    await drainPendingHostWork()

    // The refusal is what the caller sees; the internal stop never surfaces.
    expect(readMobileWebBundleErrorCode(error)).toBe('mobile_web_bundle_asset_unknown')
    // 120 chunks would page the other three assets to the end. One more round of four is the most
    // the abandoned workers can add, because each checks the stop before it asks for a chunk.
    expect(chunkCallCount(host.calls)).toBeLessThanOrEqual(atRejection + 4)
    expect(chunkCallCount(host.calls)).toBeLessThan(10)
  })

  it('asks for nothing at all when the caller arrives already aborted', async () => {
    const host = bundleHost({ 'index.html': 'abc' })

    await expect(
      fetchMobileWebBundle({ client: host.client, signal: AbortSignal.abort() })
    ).rejects.toThrow('mobile web bundle fetch aborted')
    expect(host.calls).toHaveLength(0)
  })

  it('refuses an asset the host over-pages with real bytes', async () => {
    const host = bundleHost(
      { 'index.html': 'abcdef' },
      {
        chunkBytes: 3,
        // Never says eof, so the third reply writes past the six bytes the manifest declares.
        intercept: (call) =>
          call.method === 'mobileWeb.bundle.chunk'
            ? {
                buildId: BUILD_ID,
                path: 'index.html',
                offset: paramField(call.params, 'offset'),
                assetByteLength: 6,
                sha256: toHex(sha256(bytesOf('abcdef'))),
                dataBase64: encodeBase64(bytesOf('abc')),
                eof: false
              }
            : undefined
      }
    )

    await expect(fetchMobileWebBundle({ client: host.client })).rejects.toThrow(
      'bundle asset index.html is longer than the manifest declares'
    )
  })

  it('counts the bytes it received rather than the total the manifest claims', async () => {
    const host = bundleHost({ 'index.html': 'abcdef' }, { chunkBytes: 3 })
    // The mobile reader is loose, so it does not carry the host schema's sum refinement: a manifest
    // whose total disagrees with its assets must not decide what the fetch reports.
    host.manifest.totalBytes = 999

    const fetched = await fetchMobileWebBundle({ client: host.client })

    expect(fetched.totalBytes).toBe(6)
  })

  it('reads a schema refusal whose message is prose as a generic failure', async () => {
    // The dispatcher refuses params that fail the host schema before the bundle handler runs, so the
    // message is zod prose rather than one of the six codes.
    const host = bundleHost(
      { 'index.html': 'abc' },
      {
        intercept: (call) =>
          call.method === 'mobileWeb.bundle.chunk'
            ? new Error('Invalid input: expected string, received number')
            : undefined
      }
    )

    const error = await fetchMobileWebBundle({ client: host.client }).catch(
      (thrown: unknown) => thrown
    )

    expect(readMobileWebBundleErrorCode(error)).toBeNull()
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('Invalid input: expected string, received number')
  })

  it('surfaces the host code when the bundle is not there to serve', async () => {
    const host = bundleHost(
      { 'index.html': 'abc' },
      {
        intercept: (call) =>
          call.method === 'mobileWeb.bundle.manifest'
            ? new Error('mobile_web_bundle_unavailable')
            : undefined
      }
    )

    const error = await fetchMobileWebBundle({ client: host.client }).catch(
      (thrown: unknown) => thrown
    )

    expect(readMobileWebBundleErrorCode(error)).toBe('mobile_web_bundle_unavailable')
  })
})
