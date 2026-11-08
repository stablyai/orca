import type { ExtraUsageBalance, ProviderRateLimits } from '../../shared/rate-limit-types'

/** What the provider last said about the account's room to work. */
export type UsageLimitAccountReading = {
  /** When the provider last answered. */
  checkedAt: number
  /** A plan window is used up and no overage balance can carry the next turn. */
  exhausted: boolean
  /** Latest reset among the used-up windows; null when one of them has no known reset. */
  resetsAt: number | null
}

function overageCarriesTurns(extra: ExtraUsageBalance | null | undefined): boolean {
  if (!extra?.enabled) {
    return false
  }
  if (extra.unit === 'credits') {
    return extra.unlimited || extra.balance > 0
  }
  return extra.spentPercent === null || extra.spentPercent < 100
}

/** Null when Orca has no usable reading, so the caller falls back to the agent's own reset time. */
export function readUsageLimitAccountReading(
  limits: ProviderRateLimits | null | undefined
): UsageLimitAccountReading | null {
  if (
    !limits ||
    (limits.status !== 'ok' && limits.status !== 'fetching') ||
    !Number.isFinite(limits.updatedAt) ||
    limits.updatedAt <= 0
  ) {
    return null
  }
  // Model-specific windows (Fable weekly) stay out: they block only some chats on the account.
  const used = [limits.session, limits.weekly, limits.monthly].filter(
    (window) => window != null && window.usedPercent >= 100
  )
  const exhausted = used.length > 0 && !overageCarriesTurns(limits.extraUsage)
  const resets = used.map((window) => window!.resetsAt)
  return {
    checkedAt: limits.updatedAt,
    exhausted,
    resetsAt:
      exhausted && resets.every((at): at is number => at !== null && Number.isFinite(at))
        ? Math.max(...resets)
        : null
  }
}
