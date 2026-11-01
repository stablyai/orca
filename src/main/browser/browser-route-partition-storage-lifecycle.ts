import { join } from 'node:path'
import type { BrowserRoutePartitionBinding } from './browser-route-partition-binding-store'

const PERSIST_PARTITION_PREFIX = 'persist:'

export type BrowserRoutePartitionStorageDependencies = {
  bindings: {
    listBindings(): ReadonlyMap<string, BrowserRoutePartitionBinding>
    remove(partitions: readonly string[]): number
  }
  partitionDataRoot: string
  /** True while any owner retains the partition. */
  isPartitionLive(partition: string): boolean
  clearPartitionStorage(partition: string): Promise<void>
  removePartitionDirectory(directory: string): Promise<void>
}

export type BrowserRoutePartitionStorageRelease = {
  clearedPartitions: string[]
  /** Skipped live partitions can be retried after teardown. */
  livePartitions: string[]
  removedBindings: number
  failures: unknown[]
}

// Transient transport loss must not trigger storage destruction.
export async function releaseBrowserRoutePartitionStorage(
  dependencies: BrowserRoutePartitionStorageDependencies,
  partitions: readonly string[]
): Promise<BrowserRoutePartitionStorageRelease> {
  const clearedPartitions: string[] = []
  const livePartitions: string[] = []
  const failures: unknown[] = []
  for (const partition of partitions) {
    if (dependencies.isPartitionLive(partition)) {
      livePartitions.push(partition)
      continue
    }
    try {
      // Clear through Chromium first so a warm session cannot rewrite the directory.
      await dependencies.clearPartitionStorage(partition)
      await dependencies.removePartitionDirectory(partitionDirectory(dependencies, partition))
      clearedPartitions.push(partition)
    } catch (error) {
      failures.push(error)
    }
  }
  return {
    clearedPartitions,
    livePartitions,
    removedBindings:
      clearedPartitions.length > 0 ? dependencies.bindings.remove(clearedPartitions) : 0,
    failures
  }
}

// Disconnected owners retain their storage scopes; only missing or legacy scopes are collectible.
export function findOrphanedBrowserRoutePartitions(
  dependencies: Pick<BrowserRoutePartitionStorageDependencies, 'bindings' | 'isPartitionLive'>,
  liveStorageScopes: ReadonlySet<string>
): string[] {
  const orphans: string[] = []
  for (const [partition, binding] of dependencies.bindings.listBindings()) {
    if (dependencies.isPartitionLive(partition)) {
      continue
    }
    if (binding.storageScope === null || !liveStorageScopes.has(binding.storageScope)) {
      orphans.push(partition)
    }
  }
  return orphans
}

export function findBrowserRoutePartitionsForStorageScope(
  dependencies: Pick<BrowserRoutePartitionStorageDependencies, 'bindings'>,
  storageScope: string
): string[] {
  return [...dependencies.bindings.listBindings()]
    .filter(([, binding]) => binding.storageScope === storageScope)
    .map(([partition]) => partition)
}

export function partitionDirectory(
  dependencies: Pick<BrowserRoutePartitionStorageDependencies, 'partitionDataRoot'>,
  partition: string
): string {
  return join(dependencies.partitionDataRoot, partition.slice(PERSIST_PARTITION_PREFIX.length))
}
