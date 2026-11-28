const POSITIVE_TTL_MS = 6 * 60 * 60 * 1000
const NEGATIVE_TTL_MS = 60 * 1000

export class PushReplyCategoryGate {
  private cached: { allowed: boolean; until: number } | null = null
  private pending: Promise<void> | null = null

  constructor(
    private readonly probe: () => Promise<boolean>,
    private readonly now = Date.now
  ) {
    this.refresh()
  }

  allows(): boolean {
    return this.cached?.allowed === true && this.cached.until > this.now()
  }

  refresh(): void {
    if (this.pending || (this.cached && this.cached.until > this.now())) {
      return
    }
    this.pending = this.probe()
      .catch(() => false)
      .then((allowed) => {
        this.cached = { allowed, until: this.now() + (allowed ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) }
      })
      .finally(() => {
        this.pending = null
      })
  }
}
