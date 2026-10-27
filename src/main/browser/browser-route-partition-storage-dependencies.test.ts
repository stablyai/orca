import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userData: '', fromPartition: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData },
  session: { fromPartition: mocks.fromPartition }
}))
vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: { clearRoutePartitionPolicies: vi.fn() }
}))

import { browserRoutePartitionStorageDependencies } from './browser-route-partition-storage-dependencies'
import { browserRoutePartitionPendingDeletesPath } from './browser-route-partition-pending-deletes'
import {
  configureBrowserRoutePartitionBindingsForOrcaProfile,
  currentBrowserRoutePartitionBindingFilePath
} from './browser-route-partition-binding-runtime'
import { collectOrphanedBrowserRoutePartitionStorage } from './browser-route-partition-storage-runtime'

const PARTITION = `persist:orca-browser-v1-${'a'.repeat(64)}`

let folder: string

beforeEach(() => {
  mocks.userData = mkdtempSync(join(tmpdir(), 'orca-partition-deps-'))
  folder = join(mocks.userData, 'Partitions', PARTITION.slice('persist:'.length))
  mkdirSync(folder, { recursive: true })
  mocks.fromPartition.mockReset().mockReturnValue({
    clearStorageData: vi.fn(async () => {}),
    clearCache: vi.fn(async () => {})
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
