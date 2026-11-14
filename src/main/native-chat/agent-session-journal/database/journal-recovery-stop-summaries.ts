import type { JournalPersonalStopFrontier } from '../context-epochs/journal-personal-stop-frontier'

/** Complete Stop summaries live exactly as long as their recovery witnesses and in-flight readers. */
export class JournalRecoveryStopSummaries {
  readonly values = new Map<
    string,
    {
      key: string
      identity: string | null
      rawThrough: number
      outcomeThrough: number
      context: string
      frontier: JournalPersonalStopFrontier
    }
  >()
  private retained = new Set<string>()
  private readonly readers = new Map<string, number>()

  /** Only a successful complete capsule inventory may replace this set, before audience filtering. */
  retain(ids: readonly string[]): void {
    this.retained = new Set(ids)
    this.releaseUnused()
  }

  pin(sessionIds: readonly string[]): () => void {
    const ids = new Set(sessionIds)
    for (const id of ids) {
      this.readers.set(id, (this.readers.get(id) ?? 0) + 1)
    }
    return () => {
      for (const id of ids) {
        const count = this.readers.get(id) ?? 0
        if (count > 1) {
          this.readers.set(id, count - 1)
        } else {
          this.readers.delete(id)
        }
      }
      this.releaseUnused()
    }
  }

  retains(id: string): boolean {
    return this.retained.has(id) || this.readers.has(id)
  }

  clear(): void {
    this.values.clear()
    this.retained.clear()
    this.readers.clear()
  }

  private releaseUnused(): void {
    for (const id of this.values.keys()) {
      if (!this.retains(id)) {
        this.values.delete(id)
      }
    }
  }
}
