const DEFAULT_EXPIRY_MS = 60_000
const DEFAULT_MAX_ENTRIES = 256

export class TimedOutControlRequestIndex {
  private readonly expiryById = new Map<string, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly expiryMs = DEFAULT_EXPIRY_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES
  ) {}

  remember(id: string): void {
    this.prune()
    while (this.expiryById.size >= this.maxEntries) {
      const oldest = this.expiryById.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.expiryById.delete(oldest)
    }
    this.expiryById.set(id, this.now() + this.expiryMs)
  }

  consume(id: string): boolean {
    this.prune()
    return this.expiryById.delete(id)
  }

  prune(): void {
    const now = this.now()
    for (const [id, expiry] of this.expiryById) {
      if (expiry <= now) {
        this.expiryById.delete(id)
      }
    }
  }

  clear(): void {
    this.expiryById.clear()
  }
}
