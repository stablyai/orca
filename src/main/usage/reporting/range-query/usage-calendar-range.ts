import { localUsageDay } from '../../../../shared/usage-history-range'
export { usageHistoryStartDay as getUsageRangeCutoff } from '../../../../shared/usage-history-range'
export { localUsageDay as formatLocalDay } from '../../../../shared/usage-history-range'

/** Moves a YYYY-MM-DD day by whole calendar days. */
export function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function getLocalUsageDay(timestamp: string): string | null {
  const parsed = new Date(timestamp)
  return Number.isNaN(parsed.getTime()) ? null : localUsageDay(parsed)
}
