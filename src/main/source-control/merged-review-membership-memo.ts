import { runCoalescedProbe, type CoalescedProbes } from '../git/remotes/coalesced-probe'

export type MergedReviewCommitMembership = 'contained' | 'not-contained' | 'unknown'

type Receipt<T> = { value?: T; expiresAt: number; failed?: boolean; weight: number }
type RetentionPolicy<T> = {
  weight: (value: T) => number
  maxWeight: number
  failureWeight?: number
  lru?: boolean
  ttl: (value: T) => number
}

export class MergedReviewMembershipUnavailableError extends Error {
  constructor() {
    super('Could not verify merged review commit membership')
  }
}

/** Each provider owns a partition; one provider cannot evict another's immutable receipts. */
export class MergedReviewMembershipMemo<T = MergedReviewCommitMembership> {
  private readonly receipts = new Map<string, Receipt<T>>()
  private readonly pending: CoalescedProbes<T> = new Map()

  constructor(
    private readonly policy: RetentionPolicy<T> = {
      weight: () => 1,
      maxWeight: 200,
      ttl: (value) => (value === 'unknown' ? 5 * 60_000 : 6 * 60 * 60_000)
    }
  ) {}

  clear(): void {
    this.receipts.clear()
    this.pending.clear()
  }

  discardWhere(matches: (key: string) => boolean): void {
    for (const key of new Set([...this.receipts.keys(), ...this.pending.keys()])) {
      if (matches(key)) {
        this.receipts.delete(key)
        this.pending.delete(key)
      }
    }
  }

  peek(key: string): T | undefined {
    this.prune()
    const receipt = this.receipts.get(key)
    if (receipt?.failed) {
      throw new MergedReviewMembershipUnavailableError()
    }
    if (receipt && this.policy.lru) {
      this.receipts.delete(key)
      this.receipts.set(key, receipt)
    }
    return receipt?.value
  }

  async read(
    key: string,
    load: () => Promise<T>,
    options: { refreshFailed?: boolean; bypass?: boolean } = {}
  ): Promise<T> {
    this.prune()
    const cached = this.receipts.get(key)
    if (cached && !options.bypass && !(options.refreshFailed && cached.failed)) {
      return this.peek(key)!
    }
    return runCoalescedProbe(
      this.pending,
      key,
      async (ownsKey) => {
        try {
          const value = await load()
          if (ownsKey()) {
            this.receipts.delete(key)
            const weight = this.policy.weight(value)
            if (weight <= this.policy.maxWeight) {
              this.receipts.set(key, {
                value,
                weight,
                expiresAt: Date.now() + this.policy.ttl(value)
              })
              this.prune()
            }
          }
          return value
        } catch {
          if (ownsKey()) {
            this.receipts.delete(key)
            this.receipts.set(key, {
              failed: true,
              weight: this.policy.failureWeight ?? 1,
              expiresAt: Date.now() + 5 * 60_000
            })
            this.prune()
          }
          throw new MergedReviewMembershipUnavailableError()
        }
      },
      Infinity,
      { userRefresh: options.bypass || options.refreshFailed }
    )
  }

  private prune(): void {
    const now = Date.now()
    let weight = 0
    for (const [key, receipt] of this.receipts) {
      if (receipt.expiresAt <= now) {
        this.receipts.delete(key)
      } else {
        weight += receipt.weight
      }
    }
    while (this.receipts.size > 200 || weight > this.policy.maxWeight) {
      const key = this.receipts.keys().next().value
      if (key === undefined) {
        break
      }
      weight -= this.receipts.get(key)!.weight
      this.receipts.delete(key)
    }
  }
}
