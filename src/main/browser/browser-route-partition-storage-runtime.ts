import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  deriveBrowserRoutePartitionStorageScope,
  deriveLocalSshBrowserRoutePartitionStorageScope
} from './browser-route-identity'
import { isBrowserRoutePartitionRetainedByAnyOwner } from './browser-route-partition-retention'
import {
  findBrowserRoutePartitionsForStorageScope,
  findOrphanedBrowserRoutePartitions,
  partitionDirectory,
  releaseBrowserRoutePartitionStorage,
  type BrowserRoutePartitionStorageDependencies
} from './browser-route-partition-storage-lifecycle'
import {
  browserRoutePartitionDirectoryKey,
  browserRoutePartitionPendingDeletesPath,
  deletePendingBrowserRoutePartitionDirectories
} from './browser-route-partition-pending-deletes'
import {
  activeBrowserRoutePartitionOrcaProfileId,
  currentBrowserRoutePartitionBindingFilePath
} from './browser-route-partition-binding-runtime'
import { browserRoutePartitionStorageDependencies } from './browser-route-partition-storage-dependencies'
import { getRuntimeEnvironmentRegistryRoot } from '../ipc/runtime-environments/runtime-environment-registry-root'

export type BrowserRoutePartitionStorageClear = {
  clearedPartitions: string[]
  livePartitions: string[]
}

// Require the SSH target list so uninitialized SSH state cannot make live storage look orphaned.
export async function collectOrphanedBrowserRoutePartitionStorage(
  listLocalSshTargetIds?: () => string[]
): Promise<string[]> {
  const orcaProfileId = activeBrowserRoutePartitionOrcaProfileId()
  if (!orcaProfileId) {
    return []
  }
  const dependencies = browserRoutePartitionStorageDependencies(
    isBrowserRoutePartitionRetainedByAnyOwner,
    'cold'
  )
  reportStorageFailures(
    'deferred folder deletion',
    await deletePendingBrowserRoutePartitionDirectories({
      filePath: browserRoutePartitionPendingDeletesPath(
        currentBrowserRoutePartitionBindingFilePath()
      ),
      partitionDataRoot: dependencies.partitionDataRoot,
      // Re-read per entry: a partition bound while an earlier delete awaited must survive.
      isBound: (directory) => {
        const key = browserRoutePartitionDirectoryKey(directory)
        return [...dependencies.bindings.listBindings().keys()].some(
          (partition) =>
            browserRoutePartitionDirectoryKey(partitionDirectory(dependencies, partition)) === key
        )
      },
      removeDirectory: dependencies.removePartitionDirectory
    })
  )
  const liveStorageScopes = new Set(
    listEnvironments(getRuntimeEnvironmentRegistryRoot()).map((environment) =>
      deriveBrowserRoutePartitionStorageScope({ orcaProfileId, environmentId: environment.id })
    )
  )
  if (!listLocalSshTargetIds) {
    return []
  }
  for (const targetId of listLocalSshTargetIds()) {
    liveStorageScopes.add(
      deriveLocalSshBrowserRoutePartitionStorageScope({ orcaProfileId, targetId })
    )
  }
  const orphans = findOrphanedBrowserRoutePartitions(dependencies, liveStorageScopes)
  if (orphans.length === 0) {
    return []
  }
  const released = await releaseBrowserRoutePartitionStorage(dependencies, orphans)
  reportStorageFailures('orphan collection', released.failures)
  return released.clearedPartitions
}

// Return still-live partitions separately so the caller can retry after teardown.
export async function clearBrowserRoutePartitionStorageForEnvironment(
  environmentId: string
): Promise<BrowserRoutePartitionStorageClear> {
  const orcaProfileId = activeBrowserRoutePartitionOrcaProfileId()
  if (!orcaProfileId) {
    return { clearedPartitions: [], livePartitions: [] }
  }
  const dependencies = storageDependencies()
  const partitions = findBrowserRoutePartitionsForStorageScope(
    dependencies,
    deriveBrowserRoutePartitionStorageScope({ orcaProfileId, environmentId })
  )
  if (partitions.length === 0) {
    return { clearedPartitions: [], livePartitions: [] }
  }
  const released = await releaseBrowserRoutePartitionStorage(dependencies, partitions)
  reportStorageFailures('environment removal', released.failures)
  return { clearedPartitions: released.clearedPartitions, livePartitions: released.livePartitions }
}

export async function clearBrowserRoutePartitionStorageForLocalSshTarget(
  targetId: string
): Promise<BrowserRoutePartitionStorageClear> {
  const orcaProfileId = activeBrowserRoutePartitionOrcaProfileId()
  if (!orcaProfileId) {
    return { clearedPartitions: [], livePartitions: [] }
  }
  const dependencies = storageDependencies()
  const partitions = findBrowserRoutePartitionsForStorageScope(
    dependencies,
    deriveLocalSshBrowserRoutePartitionStorageScope({ orcaProfileId, targetId })
  )
  if (partitions.length === 0) {
    return { clearedPartitions: [], livePartitions: [] }
  }
  const released = await releaseBrowserRoutePartitionStorage(dependencies, partitions)
  reportStorageFailures('ssh target removal', released.failures)
  return { clearedPartitions: released.clearedPartitions, livePartitions: released.livePartitions }
}

function storageDependencies(): BrowserRoutePartitionStorageDependencies {
  return browserRoutePartitionStorageDependencies(isBrowserRoutePartitionRetainedByAnyOwner)
}

function reportStorageFailures(stage: string, failures: readonly unknown[]): void {
  for (const failure of failures) {
    console.warn(
      `[browser-route-partition] ${stage} failed:`,
      failure instanceof Error ? failure.message : String(failure)
    )
  }
}
