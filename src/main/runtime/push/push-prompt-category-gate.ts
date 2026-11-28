const POSITIVE_TTL_MS = 6 * 60 * 60 * 1000
const NEGATIVE_TTL_MS = 60 * 1000

type Cache = { allowed: boolean; until: number }

/**
 * Positive gateway support stays cached. A miss or an error expires quickly so a later
 * upstream deploy is picked up without restarting the host. No signal means the old payload.
 */
export class PushPromptCategoryGate {
  private cached: Cache | null = null
  private pending: Promise<void> | null = null

  constructor(
    private readonly probe: () => Promise<boolean>,
    private readonly now: () => number = Date.now,
    private readonly env: () => string | undefined = () => process.env.ORCA_PUSH_PROMPT_CATEGORY
  ) {}

  allows(): boolean {
    if (this.env() === '1') {
      return true
    }
    return this.cached?.allowed === true && this.cached.until > this.now()
  }

  refresh(): void {
    if (this.env() === '1') {
      return
    }
    if (this.cached && this.cached.until > this.now()) {
      return
    }
    if (this.pending) {
      return
    }
    this.pending = this.probe()
      .then((allowed) => {
        this.cached = {
          allowed,
          until: this.now() + (allowed ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)
        }
      })
      .catch(() => {
        this.cached = { allowed: false, until: this.now() + NEGATIVE_TTL_MS }
      })
      .finally(() => {
        this.pending = null
      })
  }
}
