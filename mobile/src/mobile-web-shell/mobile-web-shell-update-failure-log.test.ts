import { describe, expect, it } from 'vitest'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import type { MobileWebBundleFetchResult } from '../transport/web-bundle/mobile-web-bundle-fetch'
import { createFakeGenerationFileSystem } from './generation-file-system-fake'
import { createGenerationStore } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import type { MobileWebShellUpdateFailure } from './mobile-web-shell-update-failure'
import { appendUpdateFailure } from './mobile-web-shell-update-failure-log'

const LOG = 'update-failures.json'

function failure(hostId: string, at: number): MobileWebShellUpdateFailure {
  return {
    hostId,
    at,
    reason: 'asset-checksum-mismatch',
    hostCode: null,
    offeredBuildId: 'c'.repeat(64),
    cachedBuildId: 'b'.repeat(64),
    outcome: 'opened-cached',
    wall: null
  }
}

describe('appendUpdateFailure', () => {
  it('drops a build id that is not a digest rather than keep host text', () => {
    const [entry] = appendUpdateFailure([], {
      ...failure('host-1', 0),
      offeredBuildId: 'https://host/?token=SECRET'
    })
    expect(entry?.offeredBuildId).toBeNull()
  })
})

describe('the generation store keeps the log', () => {
  it('writes, reads back and survives a relaunch', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await createGenerationStore({ fileSystem }).recordUpdateFailure(failure('host-1', 5))
    expect(await createGenerationStore({ fileSystem }).readUpdateFailures()).toEqual([
      failure('host-1', 5)
    ])
  })

  it("forgets one host's records and leaves the others", async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    await store.recordUpdateFailure(failure('host-1', 1))
    await store.recordUpdateFailure(failure('host-2', 2))
    await store.forgetHostUpdateFailures('host-1')
    expect((await store.readUpdateFailures()).map((entry) => entry.hostId)).toEqual(['host-2'])
    await store.forgetHostUpdateFailures('host-2')
    expect(fileSystem.text(LOG)).toBeNull()
  })

  it("outlives the host's own cache, which a recovery deletes", async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const host = deriveHostCacheKey('host-1')
    const assets = [
      { path: 'index.html', sha256: '1'.repeat(64), byteLength: 1, contentType: 'text/html' }
    ]
    const buildId = computeMobileWebBundleId(assets)
    const bundle: MobileWebBundleFetchResult = {
      manifest: {
        schemaVersion: 1,
        buildId,
        minCompatibleRuntimeProtocolVersion: 2,
        runtimeProtocolVersion: 2,
        entrypoint: 'index.html',
        totalBytes: 1,
        assets
      },
      assets: new Map([['index.html', new Uint8Array(1)]]),
      reused: [],
      totalBytes: 1,
      elapsedMs: 1
    }
    await store.commitGeneration(await store.stageGeneration(host, bundle))
    expect((await store.readActiveGeneration(host))?.buildId).toBe(buildId)
    expect(fileSystem.paths()).toContain(`${host}/generations/${buildId}/manifest.json`)
    expect(fileSystem.bytes(`${host}/generations/${buildId}/index.html`)).toEqual(new Uint8Array(1))
    const recorded = failure('host-1', 1)
    await store.recordUpdateFailure(recorded)
    await store.deleteHostCache(host)
    expect(fileSystem.paths().some((path) => path === host || path.startsWith(`${host}/`))).toBe(
      false
    )
    expect(await store.readActiveGeneration(host)).toBeNull()
    expect(await store.readUpdateFailures()).toEqual([recorded])
  })

  it('reads a corrupt log as empty and keeps the entries that still parse', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    await fileSystem.writeText(`${fileSystem.rootUri}/${LOG}`, '{not json')
    expect(await store.readUpdateFailures()).toEqual([])
    await fileSystem.writeText(
      `${fileSystem.rootUri}/${LOG}`,
      JSON.stringify([failure('host-1', 1), { ...failure('host-1', 2), url: 'wss://x/?t=1' }])
    )
    expect(await store.readUpdateFailures()).toEqual([failure('host-1', 1)])
  })
})
