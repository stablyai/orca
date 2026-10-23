import type { ProviderRateLimits } from './service-types'

export function codexResetUsageVisible(
  fresh: ProviderRateLimits,
  previous: ProviderRateLimits | null
): boolean {
  if (fresh.status !== 'ok') {
    return false
  }
  if (!previous) {
    return (fresh.session?.usedPercent ?? 0) <= 0 && (fresh.weekly?.usedPercent ?? 0) <= 0
  }
  const sessionImproved =
    fresh.session !== null &&
    (previous.session === null || fresh.session.usedPercent < previous.session.usedPercent)
  const weeklyImproved =
    fresh.weekly !== null &&
    (previous.weekly === null || fresh.weekly.usedPercent < previous.weekly.usedPercent)
  return sessionImproved || weeklyImproved
}
