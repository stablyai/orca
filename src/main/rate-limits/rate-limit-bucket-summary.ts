import type { RateLimitBucket, RateLimitWindow } from '../../shared/rate-limit-types'

/**
 * Collapses named buckets into the one window a user is actually limited by.
 *
 * The most-consumed bucket is the binding constraint: a provider that reports one pool per model
 * family runs out of the whole tier when any single pool does, so the summary has to follow the
 * worst pool rather than an average.
 */
export function deriveMostConstrainedWindow(buckets: RateLimitBucket[]): RateLimitWindow | null {
  if (buckets.length === 0) {
    return null
  }
  const mostConstrained = buckets.reduce((worst, bucket) =>
    bucket.usedPercent > worst.usedPercent ? bucket : worst
  )
  const { name: _name, ...window } = mostConstrained
  return window
}
