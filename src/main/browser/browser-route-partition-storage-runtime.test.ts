import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deriveBrowserRoutePartitionStorageScope,
  deriveLocalSshBrowserRoutePartitionStorageScope
} from './browser-route-identity'

const mocks = vi.hoisted(() => ({
  bindings: new Map<string, { fingerprint: string; storageScope: string | null }>(),
  cleared: [] as string[],
  removedDirectories: [] as string[],
  onRemoveDirectory: vi.fn<(directory: string) => void>(),
  bindingFilePath: '/tmp/orca-test-profile/browser-route-partition-bindings.json',
  environments: [{ id: 'env-1' }]
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-test-user-data' } }))
vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: () => mocks.environments
}))
vi.mock('./browser-route-partition-binding-runtime', () => ({
  activeBrowserRoutePartitionOrcaProfileId: () => 'local-default',
  currentBrowserRoutePartitionBindingFilePath: () => mocks.bindingFilePath
}))
vi.mock('./browser-route-partition-storage-dependencies', () => ({
  browserRoutePartitionStorageDependencies: (isPartitionLive: (p: string) => boolean) => ({
    bindings: {
      listBindings: () => mocks.bindings,
      remove: (partitions: readonly string[]) => {
        for (const partition of partitions) {
          mocks.bindings.delete(partition)
        }
        return partitions.length
      }
    },
    partitionDataRoot: '/tmp/orca-test-partitions',
    isPartitionLive,
    clearPartitionStorage: async (partition: string) => {
      mocks.cleared.push(partition)
    },
    removePartitionDirectory: async (directory: string) => {
      mocks.removedDirectories.push(directory)
      mocks.onRemoveDirectory(directory)
    }
  }),
  releaseEvictedBrowserRoutePartitionStorage: vi.fn(async () => {})
}))

import { browserRoutePartitionPendingDeletesPath } from './browser-route-partition-pending-deletes'
import {
  clearBrowserRoutePartitionStorageForLocalSshTarget,
  collectOrphanedBrowserRoutePartitionStorage
} from './browser-route-partition-storage-runtime'

const ENV_PARTITION = `persist:orca-browser-v1-${'a'.repeat(64)}`
const LIVE_TARGET_PARTITION = `persist:orca-browser-v1-${'b'.repeat(64)}`
const REMOVED_TARGET_PARTITION = `persist:orca-browser-v1-${'c'.repeat(64)}`

function seedBindings(): void {
  mocks.bindings.clear()
  mocks.bindings.set(ENV_PARTITION, {
    fingerprint: '1'.repeat(64),
    storageScope: deriveBrowserRoutePartitionStorageScope({
      orcaProfileId: 'local-default',
      environmentId: 'env-1'
    })
  })
  mocks.bindings.set(LIVE_TARGET_PARTITION, {
    fingerprint: '2'.repeat(64),
    storageScope: deriveLocalSshBrowserRoutePartitionStorageScope({
      orcaProfileId: 'local-default',
      targetId: 'target-live'
    })
  })
  mocks.bindings.set(REMOVED_TARGET_PARTITION, {
    fingerprint: '3'.repeat(64),
    storageScope: deriveLocalSshBrowserRoutePartitionStorageScope({
      orcaProfileId: 'local-default',
      targetId: 'target-removed'
    })
  })
}

beforeEach(() => {
  seedBindings()
  mocks.cleared.length = 0
  mocks.removedDirectories.length = 0
  mocks.onRemoveDirectory.mockReset()
})

describe('route partition storage runtime with local SSH scopes', () => {
  it('keeps partitions of listed targets and sweeps only removed-target scopes', async () => {
    const cleared = await collectOrphanedBrowserRoutePartitionStorage(() => ['target-live'])
    expect(cleared).toEqual([REMOVED_TARGET_PARTITION])
    expect(mocks.bindings.has(LIVE_TARGET_PARTITION)).toBe(true)
    expect(mocks.bindings.has(ENV_PARTITION)).toBe(true)
  })

  it('skips the sweep entirely when no target list is available', async () => {
    // Without the target list, live SSH storage is indistinguishable from orphaned storage.
    expect(await collectOrphanedBrowserRoutePartitionStorage()).toEqual([])
    expect(mocks.cleared).toEqual([])
    expect(mocks.bindings.size).toBe(3)
  })

  it('skips the sweep when reading the target list throws', async () => {
    await expect(
      collectOrphanedBrowserRoutePartitionStorage(() => {
        throw new Error('ssh target store unavailable at partition sweep')
      })
    ).rejects.toThrow('ssh target store unavailable')
    expect(mocks.cleared).toEqual([])
  })

  it('honors the retention-probe union: a retained partition survives every destructive path', async () => {
    const { registerBrowserRoutePartitionRetentionProbe } =
      await import('./browser-route-partition-retention')
    const unregister = registerBrowserRoutePartitionRetentionProbe(
      (partition) => partition === REMOVED_TARGET_PARTITION
    )
    try {
      const swept = await collectOrphanedBrowserRoutePartitionStorage(() => ['target-live'])
      expect(swept).toEqual([])
      const cleared = await clearBrowserRoutePartitionStorageForLocalSshTarget('target-removed')
      expect(cleared.clearedPartitions).toEqual([])
      expect(cleared.livePartitions).toEqual([REMOVED_TARGET_PARTITION])
      expect(mocks.bindings.has(REMOVED_TARGET_PARTITION)).toBe(true)
    } finally {
      unregister()
    }
  })

  it('clears exactly the removed target’s scope on explicit removal', async () => {
    const result = await clearBrowserRoutePartitionStorageForLocalSshTarget('target-removed')
    expect(result.clearedPartitions).toEqual([REMOVED_TARGET_PARTITION])
    expect(mocks.bindings.has(LIVE_TARGET_PARTITION)).toBe(true)
    expect(mocks.bindings.has(ENV_PARTITION)).toBe(true)
    expect(mocks.bindings.has(REMOVED_TARGET_PARTITION)).toBe(false)
  })
})

describe('deferred partition folder deletion at startup', () => {
  let profileDirectory: string

  beforeEach(() => {
    profileDirectory = mkdtempSync(join(tmpdir(), 'orca-partition-runtime-'))
    mocks.bindingFilePath = join(profileDirectory, 'browser-route-partition-bindings.json')
  })

  afterEach(() => {
    rmSync(profileDirectory, { recursive: true, force: true })
  })

  it('keeps a queued folder whose partition is bound while an earlier delete is in flight', async () => {
    const rebound = `persist:orca-browser-v1-${'d'.repeat(64)}`
    const first = join('/tmp/orca-test-partitions', `orca-browser-v1-${'e'.repeat(64)}`)
    const second = join('/tmp/orca-test-partitions', rebound.slice('persist:'.length))
    writeFileSync(
      browserRoutePartitionPendingDeletesPath(mocks.bindingFilePath),
      JSON.stringify([first, second])
    )
    mocks.onRemoveDirectory.mockImplementation((directory) => {
      if (directory === first) {
        mocks.bindings.set(rebound, {
          fingerprint: '4'.repeat(64),
          storageScope: deriveBrowserRoutePartitionStorageScope({
            orcaProfileId: 'local-default',
            environmentId: 'env-1'
          })
        })
      }
    })

    await collectOrphanedBrowserRoutePartitionStorage(() => ['target-live'])

    expect(mocks.removedDirectories).toContain(first)
    expect(mocks.removedDirectories).not.toContain(second)
  })
})
