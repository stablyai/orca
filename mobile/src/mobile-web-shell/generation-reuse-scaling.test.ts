import { sha256 } from '@noble/hashes/sha256'
import { expect, it, vi } from 'vitest'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import {
  fetchMobileWebBundle,
  type MobileWebBundleFetchResult
} from '../transport/web-bundle/mobile-web-bundle-fetch'
import type { MobileWebBundleManifestRead } from '../transport/web-bundle/mobile-web-bundle-reply-schemas'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { createFakeGenerationFileSystem } from './generation-file-system-fake'
import {
  createGenerationStore,
  type GenerationStore,
  type StagedGeneration
} from './generation-store'
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

async function installConfirmed(store: GenerationStore, staged: StagedGeneration) {
  const lease = await store.commitGeneration(staged)
  await store.confirmGeneration(lease, () => true)
  store.releaseGeneration(lease)
  return lease.generation
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
    await installConfirmed(store, await store.stageGeneration(hostKey, old))
    const active = await store.readActiveGeneration(hostKey)
    if (active === null) {
      throw new Error('Fixture generation did not activate')
    }
    if (missing) {
      await fs.delete(`${active.directory}/${active.manifest.assets[0]!.path}`)
    }
    let cachedHashReads = 0
    const reusable = reusableAssetsOf(fs, [
      {
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
      }
    ])
    const host = bundleHost(next)
    const fetched = await fetchMobileWebBundle({ client: host.client, reusable })
    await installConfirmed(store, await store.stageGeneration(hostKey, fetched))
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
  const active = await installConfirmed(store, await store.stageGeneration(hostKey, sameContent))
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

it('opens a second host on the same build without transferring any assets', async () => {
  const { old } = bundles(10)
  const fs = createFakeGenerationFileSystem()
  const store = createGenerationStore({ fileSystem: fs })
  const first = deriveHostCacheKey('first-host')
  const second = deriveHostCacheKey('second-host')
  await installConfirmed(store, await store.stageGeneration(first, old))
  const reusable = await store.openReusableAssets(second)
  const host = bundleHost(old.manifest)

  const fetched = await fetchMobileWebBundle({ client: host.client, reusable })
  await installConfirmed(store, await store.stageGeneration(second, fetched, undefined, reusable))

  expect(host.reads).toEqual([])
  expect(fetched.totalBytes).toBe(0)
  expect((await store.readActiveGeneration(second))?.buildId).toBe(old.manifest.buildId)
  for (const [index, asset] of old.manifest.assets.entries()) {
    expect(fs.bytes(`${second}/generations/${old.manifest.buildId}/${asset.path}`)).toEqual(
      Uint8Array.of(index)
    )
  }
})

it.each(['missing', 'short', 'unreadable'] as const)(
  'uses another offered copy when the first cached source is %s',
  async (failure) => {
    const { old } = bundles(1)
    const fs = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const first = deriveHostCacheKey('first-host')
    const second = deriveHostCacheKey('second-host')
    const target = deriveHostCacheKey('target-host')
    for (const key of [first, second]) {
      await installConfirmed(store, await store.stageGeneration(key, old))
    }
    const path = `${first}/generations/${old.manifest.buildId}/${old.manifest.entrypoint}`
    if (failure === 'missing') {
      await fs.delete(`${fs.rootUri}/${path}`)
    } else if (failure === 'short') {
      fs.seed(path, { kind: 'file', bytes: new Uint8Array(0) })
    } else {
      fs.failReadsAt(path)
    }
    const reusable = await store.openReusableAssets(target)
    const host = bundleHost(old.manifest)
    const fetched = await fetchMobileWebBundle({ client: host.client, reusable })

    await installConfirmed(store, await store.stageGeneration(target, fetched, undefined, reusable))

    expect(host.reads).toEqual([])
    expect(
      fs.bytes(`${target}/generations/${old.manifest.buildId}/${old.manifest.entrypoint}`)
    ).toEqual(Uint8Array.of(0))
  }
)

it('skips an ambiguous foreign generation without deleting its active or staged files', async () => {
  const { old, next } = bundles(1)
  const fs = createFakeGenerationFileSystem()
  const store = createGenerationStore({ fileSystem: fs })
  const first = deriveHostCacheKey('first-host')
  const second = deriveHostCacheKey('second-host')
  await installConfirmed(store, await store.stageGeneration(first, old))
  await store.stageGeneration(first, old)
  await fs.delete(`${fs.rootUri}/${first}/activation`)
  fs.seed(`${first}/generations/${next.buildId}/stray`, { kind: 'file', bytes: Uint8Array.of(1) })
  const before = fs.paths()

  const reusable = await store.openReusableAssets(second)

  expect(reusable.has(old.manifest.assets[0]!)).toBe(false)
  expect(fs.paths()).toEqual(before)
})

it('rejects an evicted offer without activating an incomplete generation', async () => {
  const { old } = bundles(1)
  const fs = createFakeGenerationFileSystem()
  const store = createGenerationStore({ fileSystem: fs })
  const first = deriveHostCacheKey('first-host')
  const second = deriveHostCacheKey('second-host')
  await installConfirmed(store, await store.stageGeneration(first, old))
  const reusable = await store.openReusableAssets(second)
  const fetched = await fetchMobileWebBundle({ client: bundleHost(old.manifest).client, reusable })
  await store.deleteHostCache(first)

  await expect(store.stageGeneration(second, fetched, undefined, reusable)).rejects.toThrow(
    'no file'
  )

  expect(await store.readActiveGeneration(second)).toBeNull()
  expect(fs.paths().some((path) => path.includes(`/tmp/${old.manifest.buildId}/`))).toBe(false)
})

it('finishes cross-host copies before a queued source eviction', async () => {
  const { old } = bundles(2)
  const fs = createFakeGenerationFileSystem()
  const store = createGenerationStore({ fileSystem: fs })
  const first = deriveHostCacheKey('first-host')
  const second = deriveHostCacheKey('second-host')
  await installConfirmed(store, await store.stageGeneration(first, old))
  const reusable = await store.openReusableAssets(second)
  const fetched = await fetchMobileWebBundle({ client: bundleHost(old.manifest).client, reusable })
  let entered = (): void => {}
  const copying = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release = (): void => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const copy = fs.copyFile.bind(fs)
  fs.copyFile = async (from, to) => {
    entered()
    await released
    await copy(from, to)
  }

  const staging = store.stageGeneration(second, fetched, undefined, reusable)
  await copying
  const eviction = store.deleteHostCache(first)
  release()
  const staged = await staging
  await eviction
  await installConfirmed(store, staged)

  expect(await store.readActiveGeneration(first)).toBeNull()
  expect((await store.readActiveGeneration(second))?.buildId).toBe(old.manifest.buildId)
  for (const [index, asset] of old.manifest.assets.entries()) {
    expect(fs.bytes(`${second}/generations/${old.manifest.buildId}/${asset.path}`)).toEqual(
      Uint8Array.of(index)
    )
  }
})

it.each(['duplicate', 'case-folded'] as const)(
  'does not trust a foreign generation with %s asset paths',
  async (collision) => {
    const { old } = bundles(1)
    const fs = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const first = deriveHostCacheKey('first-host')
    const second = deriveHostCacheKey('second-host')
    const original = old.manifest.assets[0]!
    const assets = [
      original,
      {
        ...original,
        path: collision === 'duplicate' ? original.path : original.path.toUpperCase(),
        sha256: Buffer.from(sha256(Uint8Array.of(255))).toString('hex')
      }
    ]
    const manifest = {
      ...old.manifest,
      assets,
      totalBytes: 2,
      buildId: computeMobileWebBundleId(assets)
    }
    const attacker = bundleHost(manifest)
    const send = attacker.client.sendRequest.bind(attacker.client)
    let reads = 0
    attacker.client.sendRequest = async (method, params) => {
      if (method !== 'mobileWeb.bundle.chunk') {
        return send(method, params)
      }
      const index = reads++
      const asset = assets[index]!
      return {
        id: 'chunk',
        ok: true,
        result: {
          buildId: manifest.buildId,
          path: asset.path,
          offset: 0,
          assetByteLength: 1,
          sha256: asset.sha256,
          dataBase64: Buffer.from([index === 0 ? 0 : 255]).toString('base64'),
          eof: true
        },
        _meta: { runtimeId: 'malicious-host' }
      }
    }
    const poisoned = await fetchMobileWebBundle({ client: attacker.client })
    await installConfirmed(store, await store.stageGeneration(first, poisoned))
    if (collision === 'duplicate') {
      expect(fs.bytes(`${first}/generations/${manifest.buildId}/${original.path}`)).toEqual(
        Uint8Array.of(255)
      )
    }
    const reusable = await store.openReusableAssets(second)
    const host = bundleHost(old.manifest)

    const fetched = await fetchMobileWebBundle({ client: host.client, reusable })
    await installConfirmed(store, await store.stageGeneration(second, fetched, undefined, reusable))

    expect(host.reads).toEqual([original.path])
    expect(fs.bytes(`${second}/generations/${old.manifest.buildId}/${original.path}`)).toEqual(
      Uint8Array.of(0)
    )
  }
)
