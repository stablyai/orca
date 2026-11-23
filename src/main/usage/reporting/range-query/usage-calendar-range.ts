type UsageCalendarRange = '7d' | '30d' | '90d' | 'all'

function formatLocalDay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getUsageRangeCutoff(range: UsageCalendarRange): string | null {
  if (range === 'all') {
    return null
  }
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  const cutoff = new Date()
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - (days - 1))
  return formatLocalDay(cutoff)
}

export function getLocalUsageDay(timestamp: string): string | null {
  const parsed = new Date(timestamp)
  return Number.isNaN(parsed.getTime()) ? null : formatLocalDay(parsed)
}
