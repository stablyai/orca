export const LINEAR_PROJECT_MAX_INFLIGHT_KEYS = 256
export const LINEAR_PROJECT_MAX_INFLIGHT_KEY_BYTES = 16 * 1024

export class LinearProjectRequestCoalescer {
  private readonly inFlight = new Map<string, Promise<unknown>>()

  coalesce<T>(key: string, load: () => Promise<T>, force = false): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined
    if (existing && !force) {
      return existing
    }

    const loaded = load()
    const mayTrack =
      Buffer.byteLength(key, 'utf8') <= LINEAR_PROJECT_MAX_INFLIGHT_KEY_BYTES &&
      (this.inFlight.has(key) || this.inFlight.size < LINEAR_PROJECT_MAX_INFLIGHT_KEYS)
    if (!mayTrack) {
      return loaded
    }

    const tracked = loaded.finally(() => {
      if (this.inFlight.get(key) === tracked) {
        this.inFlight.delete(key)
      }
    })
    this.inFlight.set(key, tracked)
    return tracked
  }

  get trackedRequestCount(): number {
    return this.inFlight.size
  }
}
