/** How a bump asks to be published; an urgent one skips the feed's coalescing delay. */
export type ProducerChange = { urgent?: boolean }

/** A producer's revision. Listeners hear each bump synchronously, possibly mid-change, so they read later. */
export class ProducerRevision {
  private count = 0
  private readonly listeners = new Set<(change: ProducerChange) => void>()

  get value(): number {
    return this.count
  }

  bump(change: ProducerChange = {}): void {
    this.count += 1
    for (const listener of this.listeners) {
      listener(change)
    }
  }

  onChange(listener: (change: ProducerChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  hasListeners(): boolean {
    return this.listeners.size > 0
  }
}
