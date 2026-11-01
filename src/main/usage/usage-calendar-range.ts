import { localUsageDay } from '../../shared/usage-history-range'
export { usageHistoryStartDay as getUsageRangeCutoff } from '../../shared/usage-history-range'

export function getLocalUsageDay(timestamp: string): string | null {
  const parsed = new Date(timestamp)
  return Number.isNaN(parsed.getTime()) ? null : localUsageDay(parsed)
}
