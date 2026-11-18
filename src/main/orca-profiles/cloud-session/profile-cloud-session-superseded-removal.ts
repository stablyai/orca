import { rm } from 'node:fs/promises'

type SupersededRemoval<T> = { inFlight: number; failed: boolean; latest: T; latestDurable: boolean }

// In-flight async removals of a superseded file; a durable save that lands meanwhile may be deleted by them.
const removals = new Map<string, SupersededRemoval<unknown>>()

export function noteDurableSave<T>(key: string, latest: T): void {
  const removal = removals.get(key)
  if (removal) {
    removal.latest = latest
    removal.latestDurable = true
  }
}

export function forget(key: string): void {
  removals.delete(key)
}

/** Once the last removal settles, puts `latest` in `retryQueue` if a durable save may be gone or a removal failed. */
export function remove<T>(key: string, path: string, latest: T, retryQueue: Map<string, T>): void {
  const removal = (removals.get(key) as SupersededRemoval<T> | undefined) ?? {
    inFlight: 0,
    failed: false,
    latest,
    latestDurable: false
  }
  removal.inFlight += 1
  removal.latest = latest
  removal.latestDurable = false
  removals.set(key, removal)
  void rm(path, { force: true })
    .catch(() => {
      removal.failed = true
    })
    .then(() => {
      removal.inFlight -= 1
      if (removal.inFlight > 0 || removals.get(key) !== removal) {
        return
      }
      removals.delete(key)
      if (removal.latestDurable || removal.failed) {
        retryQueue.set(key, removal.latest)
      }
    })
}
