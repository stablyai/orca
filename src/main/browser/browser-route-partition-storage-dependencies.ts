import { session } from 'electron'
import { rm } from 'node:fs/promises'
import {
  releaseBrowserRoutePartitionStorage,
  type BrowserRoutePartitionStorageDependencies
} from './browser-route-partition-storage-lifecycle'
import {
  currentBrowserRoutePartitionBindingFilePath,
  currentBrowserRoutePartitionBindingStore,
  routePartitionDataRoot
} from './browser-route-partition-binding-runtime'
import { browserSessionRegistry } from './browser-session-registry'
import {
  browserRoutePartitionPendingDeletesPath,
  queueBrowserRoutePartitionDirectoryDelete
} from './browser-route-partition-pending-deletes'

/**
 * `live`: this run may have loaded the session, so its data is cleared through Chromium and the
 * folder is queued for the next start. `cold`: startup, before sessions load, so the folder goes now.
 */
export function browserRoutePartitionStorageDependencies(
  isPartitionLive: (partition: string) => boolean,
  mode: 'live' | 'cold' = 'live'
): BrowserRoutePartitionStorageDependencies {
  const partitionDataRoot = routePartitionDataRoot()
  return {
    bindings: currentBrowserRoutePartitionBindingStore(),
    partitionDataRoot,
    isPartitionLive,
    clearPartitionStorage: async (partition) => {
      // Why not when cold: `fromPartition` would load the session and lock the folder it deletes.
      if (mode === 'live') {
        const partitionSession = session.fromPartition(partition)
        await partitionSession.clearStorageData()
        await partitionSession.clearCache()
        browserSessionRegistry.clearRoutePartitionPolicies(partition)
      }
    },
    removePartitionDirectory: async (directory) => {
      if (mode === 'live') {
        queueBrowserRoutePartitionDirectoryDelete(
          browserRoutePartitionPendingDeletesPath(currentBrowserRoutePartitionBindingFilePath()),
          directory
        )
        return
      }
      await rm(directory, { recursive: true, force: true })
    }
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
