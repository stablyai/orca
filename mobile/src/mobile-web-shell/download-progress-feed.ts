// Publish outside React so progress reaches the native-driver bar while JS fetch/decode work delays commits; React state alone would jump from empty to complete.
export type DownloadProgressFeed = {
  readonly current: () => number
  readonly subscribe: (listener: (fraction: number) => void) => () => void
}

export type PublishedDownloadProgressFeed = DownloadProgressFeed & {
  readonly publish: (fraction: number) => void
}

export function createDownloadProgressFeed(): PublishedDownloadProgressFeed {
  let fraction = 0
  const listeners = new Set<(fraction: number) => void>()
  return {
    current: () => fraction,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish: (next) => {
      if (next === fraction) {
        return
      }
      fraction = next
      for (const listener of listeners) {
        listener(next)
      }
    }
  }
}

export function downloadFraction(receivedBytes: number, totalBytes: number): number {
  return totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : 0
}
