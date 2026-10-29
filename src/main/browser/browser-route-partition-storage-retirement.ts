import type { BrowserRoutePartitionStorageClear } from './browser-route-partition-storage-runtime'

// Allow late page teardown before retrying the clear.
const DEFAULT_LIVE_PARTITION_RETRY_MS = 500

export type BrowserRoutePartitionStorageRetirement = {
  environmentId: string
  whenClientHostClosed: Promise<unknown>
  clearStorage(environmentId: string): Promise<BrowserRoutePartitionStorageClear>
  retryDelayMs?: number
  onError?(error: unknown): void
}

// Wait for host teardown before clearing; still-live partitions get one delayed retry.
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
