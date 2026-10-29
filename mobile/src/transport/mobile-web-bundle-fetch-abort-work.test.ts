import { sha256 } from '@noble/hashes/sha256'
import { gzipSync } from 'fflate'
import type * as FflateModule from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { fetchMobileWebBundle } from './mobile-web-bundle-fetch'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'

const work = vi.hoisted(
  (): {
    inflations: number
    hashes: number
    onHash: (() => void) | null
  } => ({ inflations: 0, hashes: 0, onHash: null })
)

vi.mock('expo-crypto', async () => {
  const { sha256: hash } = await import('@noble/hashes/sha256')
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digest: async (_algorithm: string, data: Uint8Array) => {
      work.hashes += 1
      const result = hash(data).buffer
      work.onHash?.()
      return result
    }
  }
})

vi.mock('fflate', async (importOriginal) => {
  const original = await importOriginal<typeof FflateModule>()
  return {
    ...original,
    gunzipSync: (...args: Parameters<typeof original.gunzipSync>) => {
      work.inflations += 1
      return original.gunzipSync(...args)
    }
  }
})

afterEach(() => {
  work.hashes = 0
  work.inflations = 0
  work.onHash = null
  vi.unstubAllGlobals()
})

function bundle(count: number, byteLength: number) {
  const files = Array.from({ length: count }, (_, index) => new Uint8Array(byteLength).fill(index))
  const assets = files.map((bytes, index) => ({
    path: `assets/${String(index).padStart(3, '0')}.js`,
    sha256: Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    byteLength,
    contentType: 'text/javascript'
  }))
  const manifest = {
    schemaVersion: 1,
    buildId: computeMobileWebBundleId(assets),
    minCompatibleRuntimeProtocolVersion: 2,
    runtimeProtocolVersion: 2,
    entrypoint: assets[0]?.path ?? 'index.html',
    totalBytes: count * byteLength,
    assets
  }
  return { files, manifest }
}

type Host = ReturnType<typeof createFakeRpcClient>
type Bundle = ReturnType<typeof bundle>

function answerManifest(host: Host, fixture: Bundle): void {
  expect(host.requests[0]?.method).toBe('mobileWeb.bundle.manifest')
  host.requests[0]?.resolve({
    id: 'manifest',
    ok: true,
    result: { manifest: fixture.manifest, chunkBytes: 1024, rangeBytes: 4096 },
    _meta: { runtimeId: 'runtime-1' }
  })
}

function answerRanges(host: Host, fixture: Bundle): void {
  expect(host.requests).toHaveLength(5)
  for (const [index, asset] of fixture.manifest.assets.entries()) {
    const request = host.requests[index + 1]
    expect(request?.method).toBe('mobileWeb.bundle.range')
    expect(request?.args[1]).toMatchObject({ path: asset.path, offset: 0 })
    request?.resolve({
      id: `range-${index}`,
      ok: true,
      result: {
        buildId: fixture.manifest.buildId,
        path: asset.path,
        offset: 0,
        assetByteLength: asset.byteLength,
        sha256: asset.sha256,
        eof: true,
        encoding: 'gzip',
        dataBase64: Buffer.from(gzipSync(fixture.files[index] ?? new Uint8Array())).toString(
          'base64'
        )
      },
      _meta: { runtimeId: 'runtime-1' }
    })
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function refusal(pending: Promise<unknown>): Promise<string | null> {
  return pending.then(
    () => null,
    (error: unknown) => (error instanceof MobileWebBundleFetchError ? error.refusal : 'unexpected')
  )
}

function watchAssetAllocations(assetBytes: number): number[] {
  const allocations: number[] = []
  vi.stubGlobal(
    'Uint8Array',
    new Proxy(Uint8Array, {
      construct(target, args, newTarget) {
        if (args[0] === assetBytes) {
          allocations.push(assetBytes)
        }
        return Reflect.construct(target, args, newTarget)
      }
    })
  )
  return allocations
}

describe('bundle work after the caller leaves', () => {
  it.each([10, 100])('allocates no asset buffers for a late %i-asset manifest', async (count) => {
    const assetBytes = 128 * 1024
    const fixture = bundle(count, assetBytes)
    const host = createFakeRpcClient()
    const controller = new AbortController()
    const pending = refusal(fetchMobileWebBundle({ client: host, signal: controller.signal }))
    controller.abort()
    const allocations = watchAssetAllocations(assetBytes)
    answerManifest(host, fixture)
    expect(await pending).toBe('fetch-stopped')
    expect.soft(allocations).toEqual([])
    expect(host.requests).toHaveLength(1)
    expect(work.hashes).toBe(0)
  })

  it('allocates no fallback buffers when the caller leaves during the last cache check', async () => {
    const assetBytes = 128 * 1024
    const fixture = bundle(1, assetBytes)
    const host = createFakeRpcClient()
    const controller = new AbortController()
    const progress = vi.fn()
    let finishCheck: (found: boolean) => void = () => {}
    const check = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishCheck = resolve
        })
    )
    const pending = refusal(
      fetchMobileWebBundle({
        client: host,
        signal: controller.signal,
        onProgress: progress,
        reusable: { has: () => true, check }
      })
    )
    answerManifest(host, fixture)
    await flush()
    expect(check).toHaveBeenCalledOnce()
    progress.mockClear()
    controller.abort()
    const allocations = watchAssetAllocations(assetBytes)
    finishCheck(false)
    expect(await pending).toBe('fetch-stopped')
    expect.soft(allocations).toEqual([])
    expect(host.requests).toHaveLength(1)
    expect(progress).not.toHaveBeenCalled()
    expect(work.hashes).toBe(0)
  })

  it.each([10, 100])('does no decoding or progress for %i abandoned fetches', async (count) => {
    const fixture = bundle(4, 4096)
    const progress = vi.fn()
    const pending = Array.from({ length: count }, () => {
      const host = createFakeRpcClient()
      const controller = new AbortController()
      const result = refusal(
        fetchMobileWebBundle({
          client: host,
          signal: controller.signal,
          onProgress: progress
        })
      )
      answerManifest(host, fixture)
      return { host, controller, result }
    })
    await flush()
    for (const { host, controller } of pending) {
      controller.abort()
      answerRanges(host, fixture)
    }
    expect(await Promise.all(pending.map(({ result }) => result))).toEqual(
      Array.from({ length: count }, () => 'fetch-stopped')
    )
    expect.soft(work.inflations).toBe(0)
    expect.soft(work.hashes).toBe(0)
    expect(progress).not.toHaveBeenCalled()
    expect(pending.every(({ host }) => host.requests.length === 5)).toBe(true)
  })

  it('publishes no completed asset when the caller leaves during hashing', async () => {
    const fixture = bundle(4, 4096)
    const host = createFakeRpcClient()
    const controller = new AbortController()
    const progress = vi.fn()
    const pending = refusal(
      fetchMobileWebBundle({
        client: host,
        signal: controller.signal,
        onProgress: progress
      })
    )
    answerManifest(host, fixture)
    await flush()
    work.onHash = () => controller.abort()
    answerRanges(host, fixture)
    expect(await pending).toBe('fetch-stopped')
    expect.soft(work.hashes).toBe(1)
    expect.soft(work.inflations).toBe(1)
    expect(progress).not.toHaveBeenCalled()
  })

  it('still verifies every byte and publishes progress for the live caller', async () => {
    const fixture = bundle(4, 4096)
    const host = createFakeRpcClient()
    const progress = vi.fn()
    const pending = fetchMobileWebBundle({ client: host, onProgress: progress })
    answerManifest(host, fixture)
    await flush()
    answerRanges(host, fixture)
    const result = await pending
    for (const [index, asset] of fixture.manifest.assets.entries()) {
      expect(result.assets.get(asset.path)).toEqual(fixture.files[index])
    }
    expect(work.hashes).toBe(4)
    expect(work.inflations).toBe(4)
    expect(progress).toHaveBeenCalledTimes(4)
    expect(progress).toHaveBeenLastCalledWith({
      completedAssets: 4,
      totalAssets: 4,
      receivedBytes: 16_384,
      totalBytes: 16_384
    })
  })
})
