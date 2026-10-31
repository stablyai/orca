import { sha256 } from '@noble/hashes/sha256'
import { expect, it, vi } from 'vitest'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import {
  fetchMobileWebBundle,
  type MobileWebBundleFetchResult
} from '../transport/mobile-web-bundle-fetch'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { createFakeGenerationFileSystem } from './generation-file-system-fake'
import { createGenerationStore } from './generation-store'
import { reusableAssetsOf } from './generation-reuse'
import { deriveHostCacheKey } from './host-cache-key'

vi.mock('expo-crypto', async () => {
  const { sha256: hash } = await import('@noble/hashes/sha256')
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digest: async (_algorithm: string, bytes: Uint8Array) => hash(bytes).buffer
  }
})

function bundles(count: number) {
  const assets = Array.from({ length: count }, (_, index) => {
    const bytes = Uint8Array.of(index)
    return {
      path: `assets/a-${String(index).padStart(3, '0')}.js`,
      sha256: Buffer.from(sha256(bytes)).toString('hex'),
      byteLength: bytes.byteLength,
      contentType: 'text/javascript'
    }
  })
  const manifest: MobileWebBundleManifestRead = {
    schemaVersion: 1,
    buildId: computeMobileWebBundleId(assets),
    minCompatibleRuntimeProtocolVersion: 2,
    runtimeProtocolVersion: 2,
    entrypoint: assets[0]!.path,
    assets,
    totalBytes: count
  }
  const old: MobileWebBundleFetchResult = {
    manifest,
    assets: new Map(assets.map((asset, index) => [asset.path, Uint8Array.of(index)])),
    reused: [],
    totalBytes: count,
    elapsedMs: 0
  }
  const renamed = assets.map((asset) => ({ ...asset, path: asset.path.replace('a-', 'b-') }))
  const next = {
    ...manifest,
    buildId: computeMobileWebBundleId(renamed),
    entrypoint: renamed[0]!.path,
    assets: renamed
  }
  return { old, next }
}

function bundleHost(manifest: MobileWebBundleManifestRead) {
  const reads: string[] = []
  const client: RpcClient = {
    sendRequest: async (method, params): Promise<RpcResponse> => {
      if (method === 'mobileWeb.bundle.manifest') {
        return {
          id: 'manifest',
          ok: true,
          result: { manifest, chunkBytes: 1024 },
          _meta: { runtimeId: 'reuse' }
        }
      }
      if (
        method !== 'mobileWeb.bundle.chunk' ||
        params === null ||
        typeof params !== 'object' ||
        !('path' in params) ||
        typeof params.path !== 'string'
      ) {
        throw new Error('Unexpected bundle request')
      }
      const index = manifest.assets.findIndex((asset) => asset.path === params.path)
      const asset = manifest.assets[index]
      if (asset === undefined) {
        throw new Error('Unknown asset')
      }
      reads.push(asset.path)
      return {
        id: 'chunk',
        ok: true,
        result: {
          buildId: manifest.buildId,
          path: asset.path,
          offset: 0,
          assetByteLength: asset.byteLength,
          sha256: asset.sha256,
          dataBase64: Buffer.from([index]).toString('base64'),
          eof: true
        },
        _meta: { runtimeId: 'reuse' }
      }
    },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return { client, reads }
}

it.each([
  [10, false],
  [100, false],
  [10, true],
  [100, true]
] as const)(
  'indexes %i reusable renamed assets with a missing source: %s',
  async (count, missing) => {
    const { old, next } = bundles(count)
    const fs = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const hostKey = deriveHostCacheKey('reuse-host')
    await store.commitGeneration(await store.stageGeneration(hostKey, old))
    const active = await store.readActiveGeneration(hostKey)
    if (active === null) {
      throw new Error('Fixture generation did not activate')
    }
    if (missing) {
      await fs.delete(`${active.directory}/${active.manifest.assets[0]!.path}`)
    }
    let cachedHashReads = 0
    const reusable = reusableAssetsOf(fs, {
      ...active,
      manifest: {
        ...active.manifest,
        assets: active.manifest.assets.map((asset) => ({
          ...asset,
          get sha256() {
            cachedHashReads += 1
            return asset.sha256
          }
        }))
      }
    })
    const host = bundleHost(next)
    const fetched = await fetchMobileWebBundle({ client: host.client, reusable })
    await store.commitGeneration(await store.stageGeneration(hostKey, fetched))
    const activated = await store.readActiveGeneration(hostKey)
    expect(activated?.buildId).toBe(next.buildId)
    for (const [index, asset] of next.assets.entries()) {
      expect(fs.bytes(`${hostKey}/generations/${next.buildId}/${asset.path}`)).toEqual(
        Uint8Array.of(index)
      )
    }
    expect(host.reads).toEqual(missing ? [next.assets[0]!.path] : [])
    expect(fetched.reused).toHaveLength(count - (missing ? 1 : 0))
    expect(cachedHashReads).toBeLessThanOrEqual(count)
  }
)

it('keeps the first cached path for duplicate content hashes, including a missing first file', async () => {
  const { old } = bundles(2)
  const [first, second] = old.manifest.assets
  if (first === undefined || second === undefined) {
    throw new Error('Fixture needs two assets')
  }
  const assets = [first, { ...second, sha256: first.sha256 }]
  const sameContent = {
    ...old,
    manifest: { ...old.manifest, assets, buildId: computeMobileWebBundleId(assets) },
    assets: new Map(assets.map((asset) => [asset.path, Uint8Array.of(0)]))
  }
  const fs = createFakeGenerationFileSystem()
  const store = createGenerationStore({ fileSystem: fs })
  const hostKey = deriveHostCacheKey('duplicate-host')
  const active = await store.commitGeneration(await store.stageGeneration(hostKey, sameContent))
  await fs.delete(`${active.directory}/${first.path}`)
  const reusable = await store.openReusableAssets(hostKey)
  const renamed = { ...first, path: 'assets/renamed.js' }
  expect(reusable.has(renamed)).toBe(true)
  expect(await reusable.check(renamed)).toBe(false)
  expect(fs.bytes(`${hostKey}/generations/${active.buildId}/${second.path}`)).toEqual(
    Uint8Array.of(0)
  )
  const next = {
    ...sameContent,
    manifest: {
      ...sameContent.manifest,
      assets: [renamed],
      totalBytes: 1,
      entrypoint: renamed.path,
      buildId: computeMobileWebBundleId([renamed])
    },
    assets: new Map<string, Uint8Array>(),
    reused: [renamed.path]
  }
  await expect(store.stageGeneration(hostKey, next)).rejects.toThrow('no file')
  expect((await store.readActiveGeneration(hostKey))?.buildId).toBe(active.buildId)
})
