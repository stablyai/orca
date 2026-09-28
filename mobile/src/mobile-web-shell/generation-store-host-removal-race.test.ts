import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import {
  createFakeGenerationFileSystem,
  type FakeGenerationFileSystem
} from './generation-file-system-fake'

const fake = vi.hoisted((): { fileSystem: FakeGenerationFileSystem | null } => ({
  fileSystem: null
}))

vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))
vi.mock('./generation-store-file-system', () => ({
  createExpoGenerationFileSystem: () => fake.fileSystem
}))
vi.mock('../transport/host-store', () => ({ removeHost: async () => undefined }))
vi.mock('../notifications/push-registration', () => ({
  unregisterPushForRemovedHost: async () => () => undefined
}))

import { createGenerationStore, type GenerationStore } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import { createMobileWebShellRuntime } from './mobile-web-shell-runtime'
import { resetProcessGenerationStoreForTests } from './process-generation-store'
import type { MobileWebShellUpdateFailure } from './mobile-web-shell-update-failure'
import { removeHostAndCloseClient } from '../transport/host-removal-lifecycle'

const INDEX = 'hosts.json'
const LOG = 'update-failures.json'
const REMOVED = 'host-removed'
const KEPT = 'host-kept'
const OPENED = 'host-opened'

function bundle(): MobileWebBundleFetchResult {
  const assets = [
    { path: 'index.html', sha256: '0'.repeat(64), byteLength: 4, contentType: 'text/html' }
  ]
  return {
    manifest: {
      schemaVersion: 1,
      buildId: computeMobileWebBundleId(assets),
      minCompatibleRuntimeProtocolVersion: 2,
      runtimeProtocolVersion: 2,
      entrypoint: 'index.html',
      totalBytes: 4,
      assets
    },
    assets: new Map([['index.html', new Uint8Array(4).fill(7)]]),
    totalBytes: 4,
    elapsedMs: 1
  }
}

function failure(hostId: string): MobileWebShellUpdateFailure {
  return {
    hostId,
    at: 1,
    reason: 'connection-lost',
    hostCode: null,
    offeredBuildId: null,
    cachedBuildId: null,
    outcome: 'opened-cached',
    wall: null
  }
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Every read of `file` returns what was on disk when it was issued, a macrotask later, and the
 *  first one starts the removal: the slow read a real device gives the other side's write. */
function slowReadsOf(fileSystem: FakeGenerationFileSystem, file: string, onFirst: () => void) {
  const readText = fileSystem.readText.bind(fileSystem)
  let reads = 0
  fileSystem.readText = async (target) => {
    if (target !== `${fileSystem.rootUri}/${file}`) {
      return readText(target)
    }
    const text = await readText(target)
    reads += 1
    if (reads === 1) {
      onFirst()
    }
    await macrotask()
    return text
  }
}

async function drain(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await macrotask()
  }
}

async function seedHosts(store: GenerationStore): Promise<void> {
  for (const hostId of [REMOVED, KEPT]) {
    const key = deriveHostCacheKey(hostId)
    await store.commitGeneration(await store.stageGeneration(key, bundle()))
  }
}

function indexedHostKeys(fileSystem: FakeGenerationFileSystem): string[] {
  return Object.keys(JSON.parse(fileSystem.text(INDEX) ?? '{}')).sort()
}

type Sides = { session: () => GenerationStore; removeHost: (hostId: string) => Promise<void> }

const independentInstances: Sides = {
  session: () => createGenerationStore({ fileSystem: requireFileSystem() }),
  removeHost: async (hostId) => {
    const removal = createGenerationStore({ fileSystem: requireFileSystem() })
    void removal.forgetHostUpdateFailures(hostId)
    void removal.deleteHostCache(deriveHostCacheKey(hostId)).catch(() => undefined)
  }
}

const productionSeams: Sides = {
  session: () => createMobileWebShellRuntime().createStore(),
  removeHost: (hostId) => removeHostAndCloseClient(hostId, () => undefined)
}

function requireFileSystem(): FakeGenerationFileSystem {
  if (fake.fileSystem === null) {
    throw new Error('no fake file system for this test')
  }
  return fake.fileSystem
}

/** A commit for one host with a removal of another landing inside it. */
async function removeDuringCommit(sides: Sides): Promise<FakeGenerationFileSystem> {
  const fileSystem = requireFileSystem()
  const session = sides.session()
  await seedHosts(session)
  const staged = await session.stageGeneration(deriveHostCacheKey(OPENED), bundle())
  slowReadsOf(fileSystem, INDEX, () => void sides.removeHost(REMOVED))
  await session.commitGeneration(staged)
  await drain()
  return fileSystem
}

/** A failure recorded for one host with a removal of another landing inside it. */
async function removeDuringRecord(sides: Sides): Promise<FakeGenerationFileSystem> {
  const fileSystem = requireFileSystem()
  const session = sides.session()
  await session.recordUpdateFailure(failure(REMOVED))
  slowReadsOf(fileSystem, LOG, () => void sides.removeHost(REMOVED))
  await session.recordUpdateFailure(failure(KEPT))
  await drain()
  return fileSystem
}

beforeEach(() => {
  fake.fileSystem = createFakeGenerationFileSystem()
  resetProcessGenerationStoreForTests()
})

describe('two generation store instances over one cache', () => {
  it('lose the activation a removal lands inside', async () => {
    const fileSystem = await removeDuringCommit(independentInstances)
    expect(indexedHostKeys(fileSystem)).not.toContain(deriveHostCacheKey(OPENED))
  })

  it("lose the failure a removal's forget lands inside", async () => {
    const fileSystem = await removeDuringRecord(independentInstances)
    expect(fileSystem.text(LOG)).toBeNull()
  })
})

describe('host removal and the mounted shell session', () => {
  it("delete the removed host's tree and index entry, and only that host's", async () => {
    const fileSystem = await removeDuringCommit(productionSeams)
    const removed = deriveHostCacheKey(REMOVED)
    expect(fileSystem.paths().some((path) => path.startsWith(removed))).toBe(false)
    expect(indexedHostKeys(fileSystem)).toEqual(
      [deriveHostCacheKey(KEPT), deriveHostCacheKey(OPENED)].sort()
    )
    for (const hostId of [KEPT, OPENED]) {
      expect(
        await createMobileWebShellRuntime()
          .createStore()
          .readActiveGeneration(deriveHostCacheKey(hostId))
      ).not.toBeNull()
    }
  })

  it('keep the failure recorded for another host while the removed one is forgotten', async () => {
    await removeDuringRecord(productionSeams)
    expect(
      (await createMobileWebShellRuntime().createStore().readUpdateFailures()).map(
        (entry) => entry.hostId
      )
    ).toEqual([KEPT])
  })
})
