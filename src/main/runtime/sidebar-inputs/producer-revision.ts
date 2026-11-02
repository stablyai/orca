/** A producer's revision. Listeners hear each bump synchronously, possibly mid-change, so they read later. */
export class ProducerRevision {
  private count = 0
  private readonly listeners = new Set<() => void>()

  get value(): number {
    return this.count
  }

  bump(): void {
    this.count += 1
    for (const listener of this.listeners) {
      listener()
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
