import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userData: '',
  fromPartition: vi.fn(),
  clearPolicies: vi.fn(),
  clearStorage: vi.fn(async () => {}),
  clearCache: vi.fn(async () => {})
}))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData },
  session: { fromPartition: mocks.fromPartition }
}))
vi.mock('./browser-session-partition-policies', () => ({
  installBrowserSessionPartitionPolicies: vi.fn(async () => {}),
  clearBrowserSessionPartitionPolicies: mocks.clearPolicies
}))
vi.mock('./browser-session-profile-retirement', () => ({
  retireDeletedBrowserSessionProfile: vi.fn(async () => {}),
  retireFailedBrowserSessionProfile: vi.fn(async () => {})
}))
vi.mock('./browser-session-cookie-staging', () => ({
  applyPendingBrowserCookieImports: vi.fn(),
  clearPendingBrowserCookieImport: vi.fn()
}))
vi.mock('./extensions/browser-extension-session-loader', () => ({
  attachBrowserExtensionsToProfileSession: vi.fn()
}))

import { browserRoutePartitionStorageDependencies } from './browser-route-partition-storage-dependencies'
import { browserRoutePartitionPendingDeletesPath } from './browser-route-partition-pending-deletes'
import {
  configureBrowserRoutePartitionBindingsForOrcaProfile,
  currentBrowserRoutePartitionBindingFilePath,
  currentBrowserRoutePartitionBindingStore
} from './browser-route-partition-binding-runtime'
import { collectOrphanedBrowserRoutePartitionStorage } from './browser-route-partition-storage-runtime'
import { deriveLocalSshBrowserRoutePartitionStorageScope } from './browser-route-identity'
import { registerBrowserRoutePartitionRetentionProbe } from './browser-route-partition-retention'

const PARTITION = `persist:orca-browser-v1-${'a'.repeat(64)}`

let folder: string

beforeEach(() => {
  mocks.userData = mkdtempSync(join(tmpdir(), 'orca-partition-deps-'))
  folder = join(mocks.userData, 'Partitions', PARTITION.slice('persist:'.length))
  mkdirSync(folder, { recursive: true })
  configureBrowserRoutePartitionBindingsForOrcaProfile({
    orcaProfileId: 'profile-a',
    profileDirectory: mocks.userData
  })
  mocks.clearPolicies.mockClear()
  mocks.clearStorage.mockClear()
  mocks.clearCache.mockClear()
  mocks.fromPartition.mockReset().mockReturnValue({
    clearStorageData: mocks.clearStorage,
    clearCache: mocks.clearCache
  })
})

afterEach(() => {
  rmSync(mocks.userData, { recursive: true, force: true })
})

it('clears a session this run may have loaded, and leaves its folder for the next start', async () => {
  const dependencies = browserRoutePartitionStorageDependencies(() => false)
  await dependencies.clearPartitionStorage(PARTITION)
  await dependencies.removePartitionDirectory(folder)

  expect(mocks.fromPartition).toHaveBeenCalledWith(PARTITION)
  expect(mocks.fromPartition).toHaveBeenCalledTimes(2)
  expect(mocks.clearStorage).toHaveBeenCalledTimes(1)
  expect(mocks.clearCache).toHaveBeenCalledTimes(1)
  expect(mocks.clearPolicies).toHaveBeenCalledWith(
    PARTITION,
    mocks.fromPartition.mock.results[0]?.value
  )
  // Deleting it now is what left a half-deleted folder (EBUSY) on Windows.
  expect(existsSync(folder)).toBe(true)
  const pending = browserRoutePartitionPendingDeletesPath(
    currentBrowserRoutePartitionBindingFilePath()
  )
  expect(JSON.parse(readFileSync(pending, 'utf8'))).toEqual([folder])
})

it('deletes the folder at startup without loading its session', async () => {
  const dependencies = browserRoutePartitionStorageDependencies(() => false, 'cold')
  await dependencies.clearPartitionStorage(PARTITION)
  await dependencies.removePartitionDirectory(folder)

  expect(mocks.fromPartition).not.toHaveBeenCalled()
  expect(existsSync(folder)).toBe(false)
})

it('collects cold orphan folders without opening sessions, preserving retained and listed scopes', async () => {
  const store = currentBrowserRoutePartitionBindingStore()
  const removedScope = deriveLocalSshBrowserRoutePartitionStorageScope({
    orcaProfileId: 'profile-a',
    targetId: 'removed'
  })
  const listedScope = deriveLocalSshBrowserRoutePartitionStorageScope({
    orcaProfileId: 'profile-a',
    targetId: 'listed'
  })
  const retained = `persist:orca-browser-v1-${'e'.repeat(64)}`
  const listed = `persist:orca-browser-v1-${'f'.repeat(64)}`
  const orphans = Array.from(
    { length: 2 },
    (_, index) => `persist:orca-browser-v1-${(index + 1).toString(16).padStart(64, '0')}`
  )
  const partitionFolder = (partition: string): string =>
    join(mocks.userData, 'Partitions', partition.slice('persist:'.length))
  for (const partition of [...orphans, retained, listed]) {
    store.set(partition, 'a'.repeat(64), partition === listed ? listedScope : removedScope)
    mkdirSync(partitionFolder(partition), { recursive: true })
  }
  const unregister = registerBrowserRoutePartitionRetentionProbe(
    (partition) => partition === retained
  )
  try {
    const cleared = await collectOrphanedBrowserRoutePartitionStorage(() => ['listed'])

    expect(new Set(cleared)).toEqual(new Set(orphans))
    expect(orphans.every((partition) => !existsSync(partitionFolder(partition)))).toBe(true)
    expect(existsSync(partitionFolder(retained))).toBe(true)
    expect(existsSync(partitionFolder(listed))).toBe(true)
    expect(new Set(store.listBindings().keys())).toEqual(new Set([retained, listed]))
    expect(mocks.fromPartition).not.toHaveBeenCalled()
    expect(mocks.clearPolicies).not.toHaveBeenCalled()
    expect(mocks.clearStorage).not.toHaveBeenCalled()
    expect(mocks.clearCache).not.toHaveBeenCalled()
  } finally {
    unregister()
  }
})

it('leaves a folder queued by one Orca profile for that profile to delete', async () => {
  const profileDirectory = (id: string) => {
    const directory = join(mocks.userData, 'profiles', id)
    mkdirSync(directory, { recursive: true })
    return directory
  }
  configureBrowserRoutePartitionBindingsForOrcaProfile({
    orcaProfileId: 'a',
    profileDirectory: profileDirectory('a')
  })
  await browserRoutePartitionStorageDependencies(() => false).removePartitionDirectory(folder)

  // Profile B has no binding for the folder, but profile A may have bound it again since.
  configureBrowserRoutePartitionBindingsForOrcaProfile({
    orcaProfileId: 'b',
    profileDirectory: profileDirectory('b')
  })
  await collectOrphanedBrowserRoutePartitionStorage(() => [])

  expect(existsSync(folder)).toBe(true)
})
