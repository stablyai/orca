import { describe, expect, it } from 'vitest'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import type { MobileWebBundleFetchResult } from '../transport/web-bundle/mobile-web-bundle-fetch'
import {
  createGenerationStore,
  MAX_CACHED_HOSTS,
  type GenerationStore,
  type GenerationLease
} from './generation-store'
import {
  createFakeGenerationFileSystem,
  type FakeGenerationFileSystem
} from './generation-file-system-fake'
import { deriveHostCacheKey } from './host-cache-key'

const HOST = deriveHostCacheKey('activation-host')

function bundle(size: number): MobileWebBundleFetchResult {
  const assets = [
    { path: 'index.html', sha256: '0'.repeat(64), byteLength: size, contentType: 'text/html' }
  ]
  return {
    manifest: {
      schemaVersion: 1,
      buildId: computeMobileWebBundleId(assets),
      minCompatibleRuntimeProtocolVersion: 2,
      runtimeProtocolVersion: 2,
      entrypoint: 'index.html',
      totalBytes: size,
      assets
    },
    assets: new Map([['index.html', new Uint8Array(size)]]),
    reused: [],
    totalBytes: size,
    elapsedMs: 0
  }
}

async function install(
  store: GenerationStore,
  size: number,
  host = HOST
): Promise<GenerationLease> {
  return store.commitGeneration(await store.stageGeneration(host, bundle(size)))
}

async function confirmed(
  store: GenerationStore,
  size: number,
  host = HOST
): Promise<GenerationLease> {
  const lease = await install(store, size, host)
  await store.confirmGeneration(lease, () => true)
  return lease
}

// A process stop prevents every later mutation, including best-effort cleanup.
function interruptMutations(fs: FakeGenerationFileSystem, boundary: number) {
  let stopped = false
  let steps = 0
  const before = () => {
    if (stopped) {
      throw new Error('process stopped')
    }
  }
  const after = () => {
    if (++steps === boundary) {
      stopped = true
      throw new Error('process stopped')
    }
  }
  const { writeBytes, writeText, createDirectory, delete: remove, moveDirectory } = fs
  fs.writeBytes = async (...args) => {
    before()
    await writeBytes(...args)
    after()
  }
  fs.writeText = async (...args) => {
    before()
    await writeText(...args)
    after()
  }
  fs.createDirectory = async (...args) => {
    before()
    await createDirectory(...args)
    after()
  }
  fs.delete = async (...args) => {
    before()
    await remove(...args)
    after()
  }
  fs.moveDirectory = async (...args) => {
    before()
    await moveDirectory(...args)
    after()
  }
  return () => steps
}

describe('generation activation recovery', () => {
  it('retains the installed selection when publishing the replacement fails', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const lease = await store.commitGeneration(await store.stageGeneration(HOST, bundle(4)))
    const installed = lease.generation
    await store.confirmGeneration(lease, () => true)
    store.releaseGeneration(lease)
    const replacement = await store.stageGeneration(HOST, bundle(8))
    fileSystem.moveDirectory = async () => {
      throw new Error('interrupted move')
    }

    await expect(store.commitGeneration(replacement)).rejects.toThrow('interrupted move')

    const restarted = createGenerationStore({ fileSystem })
    expect((await restarted.readActiveGeneration(HOST))?.buildId).toBe(installed.buildId)
  })

  it('opens only confirmed bytes after an unbooted replacement and process restart', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const old = await confirmed(store, 4)
    store.releaseGeneration(old)
    const pending = await install(store, 8)
    expect(pending.generation.buildId).not.toBe(old.generation.buildId)
    expect((await createGenerationStore({ fileSystem }).readActiveGeneration(HOST))?.buildId).toBe(
      old.generation.buildId
    )
    await store.rejectGeneration(pending)
    store.releaseGeneration(pending)
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(old.generation.buildId)
    await expect(install(store, 8)).rejects.toThrow('previously failed to boot')
  })

  it('never mistakes a first-install candidate for a legacy confirmed generation', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    await install(store, 4)
    expect(await createGenerationStore({ fileSystem }).readActiveGeneration(HOST)).toBeNull()
  })

  it('preserves a confirmed selection at every replacement mutation boundary', async () => {
    let boundaries = 0
    for (let boundary = 0; boundary <= boundaries; boundary++) {
      const fileSystem = createFakeGenerationFileSystem()
      const store = createGenerationStore({ fileSystem })
      const old = await confirmed(store, 4)
      store.releaseGeneration(old)
      const count = interruptMutations(fileSystem, boundary)
      await install(store, 8).catch(() => undefined)
      if (boundary === 0) {
        boundaries = count()
      }
      expect(
        (await createGenerationStore({ fileSystem }).readActiveGeneration(HOST))?.buildId,
        `mutation ${boundary}`
      ).toBe(old.generation.buildId)
    }
    expect(boundaries).toBeGreaterThan(5)
  })

  it('keeps either healthy selection at every confirmation and cleanup boundary', async () => {
    let boundaries = 0
    for (let boundary = 0; boundary <= boundaries; boundary++) {
      const fileSystem = createFakeGenerationFileSystem()
      const store = createGenerationStore({ fileSystem })
      const old = await confirmed(store, 4)
      store.releaseGeneration(old)
      const pending = await install(store, 8)
      const count = interruptMutations(fileSystem, boundary)
      await store.confirmGeneration(pending, () => true).catch(() => undefined)
      if (boundary === 0) {
        boundaries = count()
      }
      const active = await createGenerationStore({ fileSystem }).readActiveGeneration(HOST)
      expect(
        [old.generation.buildId, pending.generation.buildId],
        `mutation ${boundary}`
      ).toContain(active?.buildId)
      expect(fileSystem.bytes(`${HOST}/generations/${active?.buildId}/index.html`)).not.toBeNull()
    }
    expect(boundaries).toBeGreaterThan(1)
  })

  it('ignores a torn selection append without overwriting the confirmed record', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const old = await confirmed(store, 4)
    store.releaseGeneration(old)
    const pending = await install(store, 8)
    const write = fileSystem.writeText
    fileSystem.writeText = async (uri, text) =>
      write(uri, uri.includes('/activation/') ? text.slice(0, text.length / 2) : text)
    await expect(store.confirmGeneration(pending, () => true)).rejects.toThrow(
      'did not publish completely'
    )
    expect((await createGenerationStore({ fileSystem }).readActiveGeneration(HOST))?.buildId).toBe(
      old.generation.buildId
    )
  })

  it('refuses stale, released, superseded and removed-host confirmation authority', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const old = await confirmed(store, 4)
    store.releaseGeneration(old)
    const pending = await install(store, 8)
    await store.confirmGeneration(pending, () => false)
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(old.generation.buildId)
    const newer = await install(store, 16)
    await store.confirmGeneration(pending, () => true)
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(old.generation.buildId)
    store.releaseGeneration(newer)
    await store.confirmGeneration(newer, () => true)
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(old.generation.buildId)
    await store.deleteHostCache(HOST)
    await store.confirmGeneration(pending, () => true)
    await store.rejectGeneration(pending)
    expect(fileSystem.paths().some((path) => path.startsWith(HOST))).toBe(false)
  })

  it('rechecks current-document health after selection I/O', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const old = await confirmed(store, 4)
    store.releaseGeneration(old)
    const pending = await install(store, 8)
    let current = true
    const read = fileSystem.readText
    fileSystem.readText = async (uri) => {
      const text = await read(uri)
      if (uri.includes('/activation/')) {
        current = false
      }
      return text
    }
    await store.confirmGeneration(pending, () => current)
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(old.generation.buildId)
  })

  it('migrates a legacy single installed generation before replacing it', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const legacy = await confirmed(store, 4)
    store.releaseGeneration(legacy)
    await fileSystem.delete(`${fileSystem.rootUri}/${HOST}/activation`)
    const migrated = createGenerationStore({ fileSystem })
    expect((await migrated.readActiveGeneration(HOST))?.buildId).toBe(legacy.generation.buildId)
    await install(migrated, 8)
    expect((await createGenerationStore({ fileSystem }).readActiveGeneration(HOST))?.buildId).toBe(
      legacy.generation.buildId
    )
  })

  it('reuses the persisted same-build metadata rather than a new offer granting more access', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const old = await confirmed(store, 4)
    const offered = bundle(4)
    const staged = await store.stageGeneration(HOST, {
      ...offered,
      manifest: { ...offered.manifest, routes: [{ pathname: '/h/[hostId]', grants: ['navigate'] }] }
    })
    const reused = await store.commitGeneration(staged)
    expect(reused.generation.manifest.routes).toBeUndefined()
    expect(old.generation.manifest.routes).toBeUndefined()
  })

  it('pins live older generations through repeated publications and cleanup', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const liveOld = await confirmed(store, 4)
    for (const size of [8, 16, 32]) {
      const replacement = await confirmed(store, size)
      store.releaseGeneration(replacement)
    }
    await store.sweepStagedGenerations()
    expect(
      fileSystem.bytes(`${HOST}/generations/${liveOld.generation.buildId}/index.html`)
    ).toEqual(new Uint8Array(4))
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(bundle(32).manifest.buildId)
  })

  it('evicts inactive hosts while preserving live documents and defers an all-owned overage', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const leases: GenerationLease[] = []
    for (let index = 0; index <= MAX_CACHED_HOSTS; index++) {
      leases.push(await confirmed(store, 4, deriveHostCacheKey(`live-${index}`)))
    }
    for (const lease of leases) {
      expect(fileSystem.paths()).toContain(
        lease.generation.directory.slice(fileSystem.rootUri.length + 1)
      )
    }
    const first = leases[0]
    store.releaseGeneration(first)
    await store.sweepStagedGenerations()
    expect(fileSystem.paths()).not.toContain(
      first.generation.directory.slice(fileSystem.rootUri.length + 1)
    )
    for (const lease of leases.slice(1)) {
      expect(fileSystem.paths()).toContain(
        lease.generation.directory.slice(fileSystem.rootUri.length + 1)
      )
    }
  })

  it('falls back to the preceding confirmed build if the newly confirmed document faults', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const old = await confirmed(store, 4)
    store.releaseGeneration(old)
    const current = await confirmed(store, 8)
    await store.rejectGeneration(current)
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(old.generation.buildId)
    expect(
      fileSystem.bytes(`${HOST}/generations/${current.generation.buildId}/index.html`)
    ).not.toBeNull()
    store.releaseGeneration(current)
  })

  it('refuses a copied destination whose manifest survived but an asset did not', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const old = await confirmed(store, 4)
    store.releaseGeneration(old)
    const move = fileSystem.moveDirectory
    fileSystem.moveDirectory = async (from, to) => {
      await move(from, to)
      await fileSystem.delete(`${to}/index.html`)
    }
    await expect(install(store, 8)).rejects.toThrow('did not carry asset index.html')
    expect((await createGenerationStore({ fileSystem }).readActiveGeneration(HOST))?.buildId).toBe(
      old.generation.buildId
    )
  })

  it('cannot publish a staged install after its host was removed', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const staged = await store.stageGeneration(HOST, bundle(4))
    await store.deleteHostCache(HOST)
    await expect(store.commitGeneration(staged)).rejects.toThrow('removed host')
    expect(fileSystem.paths().some((path) => path.startsWith(HOST))).toBe(false)
  })

  it('refuses to boot an abandoned pending build again after restart', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const old = await confirmed(store, 4)
    store.releaseGeneration(old)
    await install(store, 8)
    const restarted = createGenerationStore({ fileSystem })
    await expect(install(restarted, 8)).rejects.toThrow('not confirmed before restart')
    expect((await restarted.readActiveGeneration(HOST))?.buildId).toBe(old.generation.buildId)
  })

  it('can install again after the first selection baseline write is torn', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const write = fileSystem.writeText
    fileSystem.writeText = async (uri, text) =>
      write(uri, uri.includes('/activation/') ? text.slice(0, text.length / 2) : text)
    const store = createGenerationStore({ fileSystem })
    await expect(install(store, 4)).rejects.toThrow('did not publish completely')
    fileSystem.writeText = write
    const restarted = createGenerationStore({ fileSystem })
    const healthy = await confirmed(restarted, 4)
    expect((await restarted.readActiveGeneration(HOST))?.buildId).toBe(healthy.generation.buildId)
  })

  it('retains legacy identity if its first journal baseline tears during migration', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const old = await confirmed(store, 4)
    store.releaseGeneration(old)
    await fileSystem.delete(`${fileSystem.rootUri}/${HOST}/activation`)
    const write = fileSystem.writeText
    fileSystem.writeText = async (uri, text) =>
      write(uri, uri.includes('/activation/') ? text.slice(0, text.length / 2) : text)
    const migrating = createGenerationStore({ fileSystem })
    await expect(install(migrating, 8)).rejects.toThrow('did not publish completely')
    fileSystem.writeText = write
    const restarted = createGenerationStore({ fileSystem })
    expect((await restarted.readActiveGeneration(HOST))?.buildId).toBe(old.generation.buildId)
    const candidate = await install(restarted, 8)
    expect(candidate.generation.buildId).toBe(bundle(8).manifest.buildId)
    expect((await restarted.readActiveGeneration(HOST))?.buildId).toBe(old.generation.buildId)
  })

  it('retries deferred eviction when the last staging owner aborts', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    for (let index = 0; index < MAX_CACHED_HOSTS; index++) {
      await confirmed(store, 4, deriveHostCacheKey(`retained-${index}`))
    }
    const inactive = await confirmed(store, 4)
    const staged = await store.stageGeneration(HOST, bundle(8))
    store.releaseGeneration(inactive)
    await store.sweepStagedGenerations()
    expect(fileSystem.paths()).toContain(HOST)
    await store.abortStagedGeneration(staged)
    expect(fileSystem.paths()).not.toContain(HOST)
  })

  it('holds publication ownership through the lease handoff and evicts on cancellation', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    for (let index = 0; index < MAX_CACHED_HOSTS; index++) {
      await confirmed(store, 4, deriveHostCacheKey(`retained-${index}`))
    }
    const published = await store.commitGeneration(await store.stageGeneration(HOST, bundle(4)))
    await store.sweepStagedGenerations()
    expect(fileSystem.paths()).toContain(HOST)
    store.releaseGeneration(published)
    await store.sweepStagedGenerations()
    expect(fileSystem.paths()).not.toContain(HOST)
  })
  it('releases publication ownership when a deferred eviction read rejects', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    for (let index = 0; index < MAX_CACHED_HOSTS; index++) {
      await confirmed(store, 4, deriveHostCacheKey(`retained-${index}`))
    }
    const staged = await store.stageGeneration(HOST, bundle(4))
    const list = fileSystem.list
    let rootReads = 0
    fileSystem.list = async (uri) => {
      if (uri === fileSystem.rootUri && ++rootReads === 2) {
        throw new Error('eviction read failed')
      }
      return list(uri)
    }
    const publication = await store.commitGeneration(staged).catch(() => null)
    if (publication !== null) {
      store.releaseGeneration(publication)
    }
    fileSystem.list = list
    const extra = await install(store, 4, deriveHostCacheKey('extra'))
    store.releaseGeneration(extra)
    await store.sweepStagedGenerations()
    const hosts = (await fileSystem.list(fileSystem.rootUri)).filter((entry) => entry.isDirectory)
    expect(hosts).toHaveLength(MAX_CACHED_HOSTS)
    expect(fileSystem.paths()).not.toContain(HOST)
  })
  it('does not poison a previously confirmed cache after a later launch faults', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    const old = await confirmed(store, 4)
    store.releaseGeneration(old)
    const restarted = createGenerationStore({ fileSystem })
    const opened = await restarted.acquireGeneration(HOST, old.generation)
    if (opened === null) {
      throw new Error('missing confirmed cache')
    }
    await restarted.rejectGeneration(opened)
    restarted.releaseGeneration(opened)
    expect((await restarted.readActiveGeneration(HOST))?.buildId).toBe(old.generation.buildId)
    const retry = await install(restarted, 4)
    expect(retry.generation.buildId).toBe(old.generation.buildId)
  })

  it('does not let a superseded boot reject a later confirmed attempt of the same build', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    await confirmed(store, 4)
    const retired = await install(store, 8)
    await install(store, 16)
    const current = await install(store, 8)
    await store.confirmGeneration(current, () => true)
    await store.rejectGeneration(retired)
    expect((await store.readActiveGeneration(HOST))?.buildId).toBe(current.generation.buildId)
  })
})
