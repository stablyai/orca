import type { RateLimitBucket, RateLimitWindow } from '../../shared/rate-limit-types'
import type { AntigravityQuotaGroup } from './antigravity-cloud-code-api'

const WINDOW_MINUTES: Record<string, number> = { '5h': 300, weekly: 10080 }
const WINDOW_SUFFIX: Record<string, string> = { '5h': '5h', weekly: 'Weekly' }

export const ANTIGRAVITY_SESSION_WINDOW = '5h'
export const ANTIGRAVITY_WEEKLY_WINDOW = 'weekly'

export type AntigravityBucket = RateLimitBucket & { window: string }

function toUsedPercent(remainingFraction: number): number {
  return Math.min(100, Math.max(0, Math.round((1 - remainingFraction) * 100)))
}

/**
 * Buckets stay keyed by group because two groups routinely report identical
 * percentages and reset times, and collapsing them would hide a whole model family.
 */
export function buildAntigravityBuckets(groups: AntigravityQuotaGroup[]): AntigravityBucket[] {
  return groups.flatMap((group) =>
    group.buckets.flatMap((bucket) => {
      const windowMinutes = WINDOW_MINUTES[bucket.window]
      if (windowMinutes === undefined) {
        return []
      }
      const resetsAt = new Date(bucket.resetTime).getTime()
      return [
        {
          name: `${group.displayName} (${WINDOW_SUFFIX[bucket.window]})`,
          usedPercent: toUsedPercent(bucket.remainingFraction),
          windowMinutes,
          resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
          resetDescription: null,
          window: bucket.window
        }
      ]
    })
  )
}

/** The window a user is actually constrained by is the fullest one in that period. */
export function mostConstrainedWindow(
  buckets: AntigravityBucket[],
  window: string
): RateLimitWindow | null {
  const inWindow = buckets.filter((bucket) => bucket.window === window)
  if (inWindow.length === 0) {
    return null
  }
  const worst = inWindow.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a))
  const { name: _name, window: _window, ...rest } = worst
  return rest
}

export function toRateLimitBuckets(buckets: AntigravityBucket[]): RateLimitBucket[] {
  return buckets.map(({ window: _window, ...rest }) => rest)
}
