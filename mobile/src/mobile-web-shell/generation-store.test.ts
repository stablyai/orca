import { describe, expect, it } from 'vitest'
import { createGenerationStore } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import type { MobileWebBundleFetchResult } from '../transport/web-bundle/mobile-web-bundle-fetch'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import {
  createFakeGenerationFileSystem as createFakeFileSystem,
  FAKE_GENERATION_ROOT
} from './generation-file-system-fake'

const ROOT = FAKE_GENERATION_ROOT
const HOST = deriveHostCacheKey('host-a')

function buildResult(options: {
  buildId?: string
  assets?: readonly { path: string; byteLength: number }[]
  bytes?: ReadonlyMap<string, Uint8Array>
}): MobileWebBundleFetchResult {
  const listed = options.assets ?? [
    { path: 'index.html', byteLength: 4 },
    { path: 'assets/app.js', byteLength: 2 }
  ]
  const assets = listed.map((asset, index) => ({
    path: asset.path,
    sha256: String(index).repeat(64).slice(0, 64),
    byteLength: asset.byteLength,
    contentType: 'text/html; charset=utf-8'
  }))
  const totalBytes = assets.reduce((sum, asset) => sum + asset.byteLength, 0)
  return {
    manifest: {
      schemaVersion: 1,
      buildId: options.buildId ?? computeMobileWebBundleId(assets),
      minCompatibleRuntimeProtocolVersion: 2,
      runtimeProtocolVersion: 2,
      entrypoint: 'index.html',
      totalBytes,
      assets
    },
    assets:
      options.bytes ??
      new Map(assets.map((asset) => [asset.path, new Uint8Array(asset.byteLength).fill(7)])),
    reused: [],
    totalBytes,
    elapsedMs: 1
  }
}

// Derive ids from assets so the cached manifest passes its digest check.
const BUILD = buildResult({}).manifest.buildId
const SECOND = { assets: [{ path: 'index.html', byteLength: 8 }] }
const SECOND_BUILD = buildResult(SECOND).manifest.buildId

async function activate(
  store: ReturnType<typeof createGenerationStore>,
  hostKey: string,
  result = buildResult({})
): Promise<void> {
  await store.commitGeneration(await store.stageGeneration(hostKey, result))
}

// Commit deletes the old build first, so it must not run under a page still loading that build's chunks.
describe('an update staged behind a live page', () => {
  it('stays staged while a page reads the old build, and the next read after it commits', async () => {
    const fs = createFakeFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    await activate(store, HOST)
    const release = store.holdGeneration(HOST)
    store.deferCommit(await store.stageGeneration(HOST, buildResult(SECOND)))

    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(BUILD)
    expect(await fs.fileExists(`${ROOT}/${HOST}/generations/${BUILD}/index.html`)).toBe(true)

    release()
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(SECOND_BUILD)
    expect(await fs.fileExists(`${ROOT}/${HOST}/generations/${BUILD}/index.html`)).toBe(false)
  })
})
