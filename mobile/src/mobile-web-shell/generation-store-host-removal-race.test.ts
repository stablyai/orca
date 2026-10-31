import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import {
  createFakeGenerationFileSystem,
  type FakeGenerationFileSystem
} from './generation-file-system-fake'

const fake = vi.hoisted(
  (): {
    fileSystem: FakeGenerationFileSystem | null
    pairedHostIds: () => Promise<string[]>
  } => ({
    fileSystem: null,
    pairedHostIds: async () => []
  })
)

vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))
vi.mock('./generation-store-file-system', () => ({
  createExpoGenerationFileSystem: () => fake.fileSystem
}))
vi.mock('../transport/host-store', () => ({ removeHost: async () => undefined }))
vi.mock('../transport/host-metadata-store', () => ({
  readStoredHostProfilesForMutation: async () => (await fake.pairedHostIds()).map((id) => ({ id }))
}))
vi.mock('../notifications/push-registration', () => ({
  unregisterPushForRemovedHost: async () => () => undefined
}))

import { createGenerationStore, type GenerationStore } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import { createMobileWebShellRuntime } from './mobile-web-shell-runtime'
import { resetProcessGenerationStoreForTests } from './process-generation-store'
import type { MobileWebShellUpdateFailure } from './mobile-web-shell-update-failure'
import { removeHostAndCloseClient } from '../transport/host-removal-lifecycle'

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
    reused: [],
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

// Hold the first read until host removal queues cleanup behind it.
function slowReadsOf(
  fileSystem: FakeGenerationFileSystem,
  file: string,
  onFirst: () => Promise<void>
) {
  const readText = fileSystem.readText.bind(fileSystem)
  let reads = 0
  fileSystem.readText = async (target) => {
    if (target !== `${fileSystem.rootUri}/${file}`) {
      return readText(target)
    }
    const text = await readText(target)
    reads += 1
    if (reads === 1) {
      await onFirst()
    }
    return text
  }
}

// Hold the commit's stage check until host removal queues cleanup behind it.
function slowCommitOf(fileSystem: FakeGenerationFileSystem, onFirst: () => Promise<void>) {
  const fileExists = fileSystem.fileExists.bind(fileSystem)
  let checks = 0
  fileSystem.fileExists = async (target) => {
    checks += 1
    if (checks === 1) {
      await onFirst()
    }
    return fileExists(target)
  }
}

async function seedHosts(store: GenerationStore): Promise<void> {
  for (const hostId of [REMOVED, KEPT]) {
    const key = deriveHostCacheKey(hostId)
    await store.commitGeneration(await store.stageGeneration(key, bundle()))
  }
}

type Sides = { session: () => GenerationStore; removeHost: (hostId: string) => Promise<void> }

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

async function removeDuringCommit(sides: Sides): Promise<FakeGenerationFileSystem> {
  const fileSystem = requireFileSystem()
  const session = sides.session()
  await seedHosts(session)
  const staged = await session.stageGeneration(deriveHostCacheKey(OPENED), bundle())
  slowCommitOf(fileSystem, () => sides.removeHost(REMOVED))
  await session.commitGeneration(staged)
  await session.readUpdateFailures()
  return fileSystem
}

async function removeDuringRecord(sides: Sides): Promise<FakeGenerationFileSystem> {
  const fileSystem = requireFileSystem()
  const session = sides.session()
  await session.recordUpdateFailure(failure(REMOVED))
  slowReadsOf(fileSystem, LOG, () => sides.removeHost(REMOVED))
  await session.recordUpdateFailure(failure(KEPT))
  await session.readUpdateFailures()
  return fileSystem
}

beforeEach(() => {
  fake.fileSystem = createFakeGenerationFileSystem()
  fake.pairedHostIds = async () => [REMOVED, KEPT, OPENED]
  resetProcessGenerationStoreForTests()
})

describe('host removal and the mounted shell session', () => {
  it("delete the removed host's tree, and only that host's", async () => {
    const fileSystem = await removeDuringCommit(productionSeams)
    const removed = deriveHostCacheKey(REMOVED)
    expect(fileSystem.paths().some((path) => path.startsWith(removed))).toBe(false)
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

describe('the launch sweep', () => {
  async function seedTreesFor(hostIds: readonly string[]): Promise<void> {
    const seeder = createGenerationStore({ fileSystem: requireFileSystem() })
    for (const hostId of hostIds) {
      const key = deriveHostCacheKey(hostId)
      await seeder.commitGeneration(await seeder.stageGeneration(key, bundle()))
    }
  }

  async function hostsWithTrees(): Promise<string[]> {
    const store = createMobileWebShellRuntime().createStore()
    const kept: string[] = []
    for (const hostId of [REMOVED, KEPT, OPENED]) {
      if ((await store.readActiveGeneration(deriveHostCacheKey(hostId))) !== null) {
        kept.push(hostId)
      }
    }
    return kept
  }

  it("drops a tree whose host was removed while the delete never ran, and keeps every paired host's", async () => {
    await seedTreesFor([REMOVED, KEPT, OPENED])
    fake.pairedHostIds = async () => [KEPT, OPENED]
    expect(await hostsWithTrees()).toEqual([KEPT, OPENED])
  })

  it('keeps every tree when the host list cannot be read or reads back empty', async () => {
    await seedTreesFor([KEPT, OPENED])
    fake.pairedHostIds = async () => {
      throw new Error('host list storage unreadable')
    }
    expect(await hostsWithTrees()).toEqual([KEPT, OPENED])
    resetProcessGenerationStoreForTests()
    fake.pairedHostIds = async () => []
    expect(await hostsWithTrees()).toEqual([KEPT, OPENED])
  })
})
