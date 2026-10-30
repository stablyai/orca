import type { RateLimitBucket, RateLimitWindow } from '../../shared/rate-limit-types'

/** Any exhausted model pool limits the tier; summarize the most-consumed bucket rather than averaging. */
export function deriveMostConstrainedWindow(buckets: RateLimitBucket[]): RateLimitWindow | null {
  if (buckets.length === 0) {
    return null
  }
  const mostConstrained = buckets.reduce((worst, bucket) =>
    bucket.usedPercent > worst.usedPercent ? bucket : worst
  )
  const { usedPercent, windowMinutes, resetsAt, resetDescription } = mostConstrained
  return { usedPercent, windowMinutes, resetsAt, resetDescription }
}
