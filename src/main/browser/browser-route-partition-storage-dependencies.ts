import { session } from 'electron'
import { rm } from 'node:fs/promises'
import {
  releaseBrowserRoutePartitionStorage,
  type BrowserRoutePartitionStorageDependencies
} from './browser-route-partition-storage-lifecycle'
import {
  currentBrowserRoutePartitionBindingStore,
  routePartitionDataRoot
} from './browser-route-partition-binding-runtime'
import { browserSessionRegistry } from './browser-session-registry'

export function browserRoutePartitionStorageDependencies(
  isPartitionLive: (partition: string) => boolean
): BrowserRoutePartitionStorageDependencies {
  return {
    bindings: currentBrowserRoutePartitionBindingStore(),
    partitionDataRoot: routePartitionDataRoot(),
    isPartitionLive,
    clearPartitionStorage: async (partition) => {
      const partitionSession = session.fromPartition(partition)
      await partitionSession.clearStorageData()
      await partitionSession.clearCache()
      browserSessionRegistry.clearRoutePartitionPolicies(partition)
    },
    removePartitionDirectory: (directory) => rm(directory, { recursive: true, force: true })
  }
}

// Recheck liveness after eviction because a partition may have been prepared again.
export async function releaseEvictedBrowserRoutePartitionStorage(
  partitions: readonly string[],
  isPartitionLive: (partition: string) => boolean
): Promise<void> {
  if (partitions.length === 0) {
    return
  }
  const released = await releaseBrowserRoutePartitionStorage(
    browserRoutePartitionStorageDependencies(isPartitionLive),
    partitions
  )
  for (const failure of released.failures) {
    console.warn(
      '[browser-route-partition] binding eviction failed:',
      failure instanceof Error ? failure.message : String(failure)
    )
  }
}
