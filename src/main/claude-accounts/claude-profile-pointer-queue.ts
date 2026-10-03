/** Per-target publish generations and serialized pointer writes: only the newest publish of a
 *  target may write or withdraw its pointer, and writes for one target never interleave. */
export class ClaudeProfilePointerQueue<T> {
  private readonly generations = new Map<string, number>()
  private readonly latest = new Map<string, Promise<T>>()
  private readonly writes = new Map<string, Promise<unknown>>()
  private readonly running = new Map<string, number>()

  start(key: string, run: (generation: number) => Promise<T>): Promise<T> {
    const generation = this.supersede(key)
    const published = run(generation)
    this.latest.set(key, published)
    this.running.set(key, (this.running.get(key) ?? 0) + 1)
    const settled = () => this.running.set(key, (this.running.get(key) ?? 1) - 1)
    published.then(settled, settled)
    return published
  }

  /** Makes every earlier generation stale; returns the new one. */
  supersede(key: string, newest?: Promise<T>): number {
    const generation = (this.generations.get(key) ?? 0) + 1
    this.generations.set(key, generation)
    if (newest) {
      this.latest.set(key, newest)
    }
    return generation
  }

  isNewest(key: string, generation: number): boolean {
    return generation === this.generations.get(key)
  }

  newest(key: string): Promise<T> | undefined {
    return this.latest.get(key)
  }

  busy(key: string): boolean {
    return Boolean(this.running.get(key))
  }

  /** Runs `operation` after earlier writes for `key`, only if `generation` is still the newest. */
  async write(key: string, generation: number, operation: () => Promise<void>): Promise<boolean> {
    const next = (this.writes.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (!this.isNewest(key, generation)) {
          return false
        }
        await operation()
        return true
      })
    this.writes.set(key, next)
    try {
      return await next
    } finally {
      if (this.writes.get(key) === next) {
        this.writes.delete(key)
      }
    }
  }
}
