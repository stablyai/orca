import type { BrowserRoutePartitionStorageClear } from './browser-route-partition-storage-runtime'

// Why: a partition is released once its client-hosted pages finish tearing down; the retry gives
// that teardown a moment to land rather than deferring the clear to the next startup sweep.
const DEFAULT_LIVE_PARTITION_RETRY_MS = 500

export type BrowserRoutePartitionStorageRetirement = {
  environmentId: string
  /** Settles when the environment's client-host composition has finished closing. */
  whenClientHostClosed: Promise<unknown>
  clearStorage(environmentId: string): Promise<BrowserRoutePartitionStorageClear>
  retryDelayMs?: number
  onError?(error: unknown): void
}

/**
 * Clears a removed environment's route-partition storage once its client host is gone.
 *
 * Ordering is the point: clearing while the composition still holds prepared pages refuses every
 * live partition, and nothing retries it. Teardown failure does not cancel the clear -- a removed
 * environment's storage goes either way -- and one retry covers a partition released just after the
 * first pass read it as live.
 */
export async function retireBrowserRoutePartitionStorageForEnvironment(
  options: BrowserRoutePartitionStorageRetirement
): Promise<string[]> {
  await options.whenClientHostClosed.catch((error) => options.onError?.(error))
  const first = await options.clearStorage(options.environmentId)
  if (first.livePartitions.length === 0) {
    return first.clearedPartitions
  }
  await delay(options.retryDelayMs ?? DEFAULT_LIVE_PARTITION_RETRY_MS)
  const retried = await options.clearStorage(options.environmentId)
  if (retried.livePartitions.length > 0) {
    options.onError?.(
      new Error(
        `Route partitions still live after client host teardown: ${retried.livePartitions.join(', ')}`
      )
    )
  }
  return [...first.clearedPartitions, ...retried.clearedPartitions]
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}
