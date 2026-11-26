// Open browser pages per partition, freed ones included: a page leaves only when its tab closes.

const pagesByPartition = new Map<string, number>()
const emptiedListeners = new Set<(partition: string) => void>()

export function noteBrowserPageOpened(partition: string): void {
  pagesByPartition.set(partition, (pagesByPartition.get(partition) ?? 0) + 1)
}

export function noteBrowserPageClosed(partition: string): void {
  const left = (pagesByPartition.get(partition) ?? 1) - 1
  if (left > 0) {
    pagesByPartition.set(partition, left)
    return
  }
  pagesByPartition.delete(partition)
  for (const listener of emptiedListeners) {
    listener(partition)
  }
}

export function hasOpenBrowserPages(partition: string): boolean {
  return pagesByPartition.has(partition)
}

/** Runs when a partition's last open page closes. */
export function onBrowserPartitionPagesClosed(listener: (partition: string) => void): () => void {
  emptiedListeners.add(listener)
  return () => emptiedListeners.delete(listener)
}
