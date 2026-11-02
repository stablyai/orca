import type { BrowserCookieImportSummary } from '../../../shared/browser-workspace-types'
import type { ImportWriteSkip, PlannableCookie } from './browser-cookie-import-write'

export function summarizePartitionSkips(
  skips: readonly ImportWriteSkip<PlannableCookie>[]
): Pick<BrowserCookieImportSummary, 'partitionSkippedCookies' | 'partitionSkipBreakdown'> {
  if (skips.length === 0) {
    return {}
  }
  const unreadableCookies = skips.filter(
    (skip) => skip.cookie.partition.status === 'unreadable'
  ).length
  return {
    partitionSkippedCookies: skips.length,
    partitionSkipBreakdown: {
      unreadableCookies,
      preservedRelatedCookies: skips.length - unreadableCookies
    }
  }
}
