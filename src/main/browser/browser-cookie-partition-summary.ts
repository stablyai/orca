import type { BrowserCookieImportSummary } from '../../shared/browser-workspace-types'
import type { ImportWriteSkip, PlannableCookie } from './browser-cookie-import-write'

/** Reports unreadable partitions and family-preserved rows without cookie identifiers or values. */
export function summarizePartitionSkips(
  skips: readonly ImportWriteSkip<PlannableCookie>[]
): BrowserCookieImportSummary['partitionSkipBreakdown'] {
  if (skips.length === 0) {
    return undefined
  }
  let unreadableCookies = 0
  const domains = new Set<string>()
  const reasons = new Map<string, number>()
  for (const { cookie } of skips) {
    domains.add(cookie.domain.replace(/^\.+/, ''))
    if (cookie.partition.status === 'unreadable') {
      unreadableCookies++
      const reason = cookie.partition.reason
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    }
  }
  return {
    unreadableCookies,
    preservedRelatedCookies: skips.length - unreadableCookies,
    domains: [...domains].sort(),
    reasons: [...reasons]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => ({ reason, count }))
  }
}
