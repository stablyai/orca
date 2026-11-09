import { runCoalescedProbe, type CoalescedProbes } from '../git/remotes/coalesced-probe'

export type MergedReviewCommitMembership = 'contained' | 'not-contained' | 'unknown'

type Receipt = { value: MergedReviewCommitMembership; expiresAt: number; failed?: boolean }

export class MergedReviewMembershipUnavailableError extends Error {
  constructor() {
    super('Could not verify merged review commit membership')
  }
}

/** Each provider owns a partition; one provider cannot evict another's immutable verdicts. */
export class MergedReviewMembershipMemo {
  private readonly receipts = new Map<string, Receipt>()
  private readonly pending: CoalescedProbes<MergedReviewCommitMembership> = new Map()

  clear(): void {
    this.receipts.clear()
    this.pending.clear()
  }

  peek(key: string): MergedReviewCommitMembership | undefined {
    this.prune()
    const receipt = this.receipts.get(key)
    if (receipt?.failed) {
      throw new MergedReviewMembershipUnavailableError()
    }
    return receipt?.value
  }

  async read(
    key: string,
    load: () => Promise<MergedReviewCommitMembership>,
    options: { refreshFailed?: boolean; bypass?: boolean } = {}
  ): Promise<MergedReviewCommitMembership> {
    this.prune()
    const cached = this.receipts.get(key)
    if (cached && !options.bypass && !(options.refreshFailed && cached.failed)) {
      if (cached.failed) {
        throw new MergedReviewMembershipUnavailableError()
      }
      return cached.value
    }
    return runCoalescedProbe(
      this.pending,
      key,
      async (ownsKey) => {
        try {
          const value = await load()
          if (ownsKey()) {
            this.receipts.set(key, {
              value,
              expiresAt: Date.now() + (value === 'unknown' ? 5 * 60_000 : 6 * 60 * 60_000)
            })
            this.prune()
          }
          return value
        } catch {
          if (ownsKey()) {
            this.receipts.set(key, {
              value: 'unknown',
              failed: true,
              expiresAt: Date.now() + 5 * 60_000
            })
            this.prune()
          }
          throw new MergedReviewMembershipUnavailableError()
        }
      },
      // A slow live walk stays shared; elapsed time alone must not multiply it.
      Infinity,
      { userRefresh: options.bypass || options.refreshFailed }
    )
  }

  private prune(): void {
    const now = Date.now()
    for (const [key, receipt] of this.receipts) {
      if (receipt.expiresAt <= now) {
        this.receipts.delete(key)
      }
    }
    while (this.receipts.size > 200) {
      const key = this.receipts.keys().next().value
      if (key === undefined) {
        break
      }
      this.receipts.delete(key)
    }
  }
}
