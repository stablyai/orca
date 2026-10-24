/**
 * How far one session's download has got, as a fraction, for the bar to follow outside React.
 *
 * The fetch's replies keep the JS thread busy for the whole download, so React commits nothing until
 * it ends; a bar drawn from state sat at zero and then jumped. A listener here runs inside the
 * dispatch that carries the progress, and the bar hands each value to the native driver from it.
 */
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
