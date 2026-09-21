import { join } from 'node:path'
import type { BrowserRoutePartitionBinding } from './browser-route-partition-binding-store'

const PERSIST_PARTITION_PREFIX = 'persist:'

export type BrowserRoutePartitionStorageDependencies = {
  bindings: {
    listBindings(): ReadonlyMap<string, BrowserRoutePartitionBinding>
    remove(partitions: readonly string[]): number
  }
  partitionDataRoot: string
  /** True while a partition still has prepared pages; its storage is never touched. */
  isPartitionLive(partition: string): boolean
  clearPartitionStorage(partition: string): Promise<void>
  removePartitionDirectory(directory: string): Promise<void>
}

export type BrowserRoutePartitionStorageRelease = {
  clearedPartitions: string[]
  /** Partitions skipped because they still had prepared pages; the caller may retry them later. */
  livePartitions: string[]
  removedBindings: number
  failures: unknown[]
}

/**
 * Destroys the persisted storage of specific route partitions.
 *
 * Only explicit lifecycle events call this -- environment removal or pairing
 * revocation. Transient transport loss must never reach it.
 */
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
      // Why: clear through Chromium first so a warm session cannot rewrite the directory.
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

/**
 * Collects route partitions no live environment record can reach any more.
 *
 * Conservative by construction: a partition is an orphan only when its owning
 * environment record is gone, or when it predates storage scopes and therefore
 * carries a partition name the current identity scheme can never re-derive. A
 * merely disconnected host keeps its record, and so keeps its storage.
 */
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

function partitionDirectory(
  dependencies: Pick<BrowserRoutePartitionStorageDependencies, 'partitionDataRoot'>,
  partition: string
): string {
  return join(dependencies.partitionDataRoot, partition.slice(PERSIST_PARTITION_PREFIX.length))
}
