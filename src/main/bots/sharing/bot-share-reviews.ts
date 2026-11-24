// The reviews the owner opened: each recipient content kept in main under an id, so Create writes the
// content that was shown and the renderer never sends content of its own.
import { randomUUID } from 'node:crypto'
import type { BotRecipientContent } from './bot-share-recipient'

const REVIEW_TTL_MS = 30 * 60 * 1000
const MAX_REVIEWS = 8

export class BotShareReviews {
  private readonly reviews = new Map<string, { content: BotRecipientContent; expiresAt: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Keeps a review; the oldest goes when there are too many. */
  put(content: BotRecipientContent): string {
    this.prune()
    while (this.reviews.size >= MAX_REVIEWS) {
      const [oldest] = this.reviews.keys()
      this.reviews.delete(oldest)
    }
    const reviewId = randomUUID()
    this.reviews.set(reviewId, { content, expiresAt: this.now() + REVIEW_TTL_MS })
    return reviewId
  }

  /** The reviewed content; null once it expired or was never kept here. */
  get(reviewId: string): BotRecipientContent | null {
    this.prune()
    return this.reviews.get(reviewId)?.content ?? null
  }

  private prune(): void {
    for (const [id, review] of this.reviews) {
      if (review.expiresAt <= this.now()) {
        this.reviews.delete(id)
      }
    }
  }
}
