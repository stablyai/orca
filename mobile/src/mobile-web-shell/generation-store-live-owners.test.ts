import { describe, expect, it } from 'vitest'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'
import { createGenerationStore, MAX_CACHED_HOSTS } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import { createFakeGenerationFileSystem } from './generation-file-system-fake'

function bundle(version: number): MobileWebBundleFetchResult {
  const assets = [
    {
      path: 'index.html',
      sha256: `${version}`.repeat(64),
      byteLength: version,
      contentType: 'text/html'
    },
    {
      path: 'later-route.js',
      sha256: '0'.repeat(64),
      byteLength: 1,
      contentType: 'text/javascript'
    }
  ]
  const totalBytes = version + 1
  return {
    manifest: {
      schemaVersion: 1,
      buildId: computeMobileWebBundleId(assets),
      runtimeProtocolVersion: 2,
      minCompatibleRuntimeProtocolVersion: 2,
      entrypoint: 'index.html',
      totalBytes,
      assets
    },
    assets: new Map(assets.map((asset) => [asset.path, new Uint8Array(asset.byteLength)])),
    totalBytes,
    elapsedMs: 0
  }
}

const HOST = deriveHostCacheKey('desktop-a')

describe('live mobile shell generations', () => {
  it('keeps a cold route chunk until both retained views retire, then reclaims only the old build', async () => {
    const fs = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const first = await store.commitGeneration(await store.stageGeneration(HOST, bundle(1)))
    const view = store.createOwner()
    const secondView = store.createOwner()
    await store.readActiveGeneration(HOST, view)
    await store.readActiveGeneration(HOST, secondView)
    const updated = await store.commitGeneration(await store.stageGeneration(HOST, bundle(2)))
    const chunk = `${first.directory}/later-route.js`

    expect(await fs.fileExists(chunk)).toBe(true)
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(updated.buildId)
    view.release()
    await store.readActiveGeneration(HOST)
    expect(await fs.fileExists(chunk)).toBe(true)
    secondView.release()
    secondView.release()
    await store.readActiveGeneration(HOST)
    expect(await fs.fileExists(chunk)).toBe(false)
    expect(await fs.fileExists(`${updated.directory}/later-route.js`)).toBe(true)
  })

  it('pins a downloaded generation in the commit queue before another activation can retire it', async () => {
    const fs = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const owner = store.createOwner()
    const firstStage = await store.stageGeneration(HOST, bundle(1))
    const secondStage = await store.stageGeneration(HOST, bundle(2))
    const [first, second] = await Promise.all([
      store.commitGeneration(firstStage, owner),
      store.commitGeneration(secondStage)
    ])
    expect(await fs.fileExists(`${first.directory}/later-route.js`)).toBe(true)
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(second.buildId)
    owner.release()
    await store.readActiveGeneration(HOST)
    expect(await fs.fileExists(`${first.directory}/later-route.js`)).toBe(false)
  })

  it('does not acquire a retired owner when a queued cache read completes after unmount', async () => {
    const fs = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const first = await store.commitGeneration(await store.stageGeneration(HOST, bundle(1)))
    const owner = store.createOwner()
    const pendingRead = store.readActiveGeneration(HOST, owner)
    owner.release()
    await pendingRead
    await store.commitGeneration(await store.stageGeneration(HOST, bundle(2)))
    expect(await fs.fileExists(`${first.directory}/later-route.js`)).toBe(false)
  })

  it('reclaims retired generations after process restart while keeping the selected current cache', async () => {
    const fs = createFakeGenerationFileSystem()
    const beforeRestart = createGenerationStore({ fileSystem: fs })
    const first = await beforeRestart.commitGeneration(
      await beforeRestart.stageGeneration(HOST, bundle(1))
    )
    await beforeRestart.readActiveGeneration(HOST, beforeRestart.createOwner())
    const second = await beforeRestart.commitGeneration(
      await beforeRestart.stageGeneration(HOST, bundle(2))
    )
    const restarted = createGenerationStore({ fileSystem: fs })
    await restarted.sweepStagedGenerations()
    expect((await restarted.readActiveGeneration(HOST))?.buildId).toBe(second.buildId)
    expect(await fs.fileExists(`${first.directory}/later-route.js`)).toBe(false)
  })

  it('evicts unowned older hosts while preserving a mounted host and the newest activation', async () => {
    const fs = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const owner = store.createOwner()
    const first = await store.commitGeneration(await store.stageGeneration(HOST, bundle(1)), owner)
    for (let index = 0; index < MAX_CACHED_HOSTS; index += 1) {
      const key = deriveHostCacheKey(`other-${index}`)
      await store.commitGeneration(await store.stageGeneration(key, bundle(1)))
    }
    expect(await fs.fileExists(`${first.directory}/later-route.js`)).toBe(true)
    const oldestUnowned = deriveHostCacheKey('other-0')
    expect(await store.readActiveGeneration(oldestUnowned)).toBeNull()
    expect(JSON.parse(fs.text('hosts.json') ?? '[]')).toHaveLength(MAX_CACHED_HOSTS)
    owner.release()
  })

  it('allows only live hosts above the ceiling and trims them when owners retire', async () => {
    const fs = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const owners = []
    for (let index = 0; index <= MAX_CACHED_HOSTS; index += 1) {
      const owner = store.createOwner()
      owners.push(owner)
      const key = deriveHostCacheKey(`mounted-${index}`)
      await store.commitGeneration(await store.stageGeneration(key, bundle(1)), owner)
    }
    expect(JSON.parse(fs.text('hosts.json') ?? '[]')).toHaveLength(MAX_CACHED_HOSTS + 1)
    owners[0]?.release()
    await store.readUpdateFailures()
    expect(JSON.parse(fs.text('hosts.json') ?? '[]')).toHaveLength(MAX_CACHED_HOSTS)
    expect(await store.readActiveGeneration(deriveHostCacheKey('mounted-0'))).toBeNull()
    for (const owner of owners) {
      owner.release()
    }
  })

  it('still removes a forgotten host immediately and a late owner release cannot resurrect it', async () => {
    const fs = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const owner = store.createOwner()
    const first = await store.commitGeneration(await store.stageGeneration(HOST, bundle(1)), owner)
    await store.deleteHostCache(HOST)
    expect(await fs.fileExists(`${first.directory}/later-route.js`)).toBe(false)
    owner.release()
    await store.readUpdateFailures()
    expect(fs.paths().some((path) => path.startsWith(HOST))).toBe(false)
  })

  it('does not delete mounted files when the current cache index is corrupt', async () => {
    const fs = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem: fs })
    const owner = store.createOwner()
    const first = await store.commitGeneration(await store.stageGeneration(HOST, bundle(1)), owner)
    await store.commitGeneration(await store.stageGeneration(HOST, bundle(2)))
    await fs.writeText(`${fs.rootUri}/${HOST}/active-build.json`, 'truncated')
    expect(await store.readActiveGeneration(HOST)).toBeNull()
    expect(await fs.fileExists(`${first.directory}/later-route.js`)).toBe(true)
    owner.release()
    await store.readUpdateFailures()
    expect(await store.readActiveGeneration(HOST)).toBeNull()
    expect(fs.paths().some((path) => path.startsWith(HOST))).toBe(false)
  })
})

it('does not reopen an invalidated live cache after a process restart', async () => {
  const fs = createFakeGenerationFileSystem()
  const firstProcess = createGenerationStore({ fileSystem: fs })
  const owner = firstProcess.createOwner()
  await firstProcess.commitGeneration(await firstProcess.stageGeneration(HOST, bundle(1)), owner)
  await firstProcess.deleteHostCache(HOST, true)
  const nextProcess = createGenerationStore({ fileSystem: fs })
  await nextProcess.sweepStagedGenerations()
  expect(await nextProcess.readActiveGeneration(HOST)).toBeNull()
  expect(fs.paths().some((path) => path.startsWith(HOST))).toBe(false)
})
