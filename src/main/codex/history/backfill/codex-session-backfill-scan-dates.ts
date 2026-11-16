import type { CodexSessionBackfillDate } from './codex-session-backfill-types'

export function getCodexSessionBackfillDate(date = new Date()): CodexSessionBackfillDate {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ]
}

export function isCodexSessionBackfillDate(value: unknown): value is CodexSessionBackfillDate {
  if (!Array.isArray(value) || value.length !== 3) {
    return false
  }
  const key = value.join('-')
  // Validate calendar dates but allow future ones: clock-skewed rollouts still contain real sessions.
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(key) &&
    toCodexSessionBackfillDateKey(formatUtcCalendarDate(toUtcDate(value))) === key
  )
}

export function toCodexSessionBackfillDateKey(date: CodexSessionBackfillDate): string {
  return date.join('-')
}

export function compareCodexSessionBackfillDates(
  left: CodexSessionBackfillDate,
  right: CodexSessionBackfillDate
): number {
  return toCodexSessionBackfillDateKey(left).localeCompare(toCodexSessionBackfillDateKey(right))
}

export function mergeCodexSessionBackfillDates(
  ...groups: readonly (readonly CodexSessionBackfillDate[] | undefined)[]
): CodexSessionBackfillDate[] {
  const merged = new Map<string, CodexSessionBackfillDate>()
  for (const group of groups) {
    for (const date of group ?? []) {
      if (isCodexSessionBackfillDate(date)) {
        merged.set(toCodexSessionBackfillDateKey(date), date)
      }
    }
  }
  return [...merged.values()].sort(compareCodexSessionBackfillDates)
}

export function subtractCodexSessionBackfillDates(
  dates: readonly CodexSessionBackfillDate[],
  removed: readonly CodexSessionBackfillDate[]
): CodexSessionBackfillDate[] {
  const removedKeys = new Set(removed.map(toCodexSessionBackfillDateKey))
  return dates.filter((date) => !removedKeys.has(toCodexSessionBackfillDateKey(date)))
}

export function parseCodexSessionBackfillDates(value: unknown): CodexSessionBackfillDate[] {
  return Array.isArray(value)
    ? mergeCodexSessionBackfillDates(value.filter(isCodexSessionBackfillDate))
    : []
}

export function getCodexSessionBackfillDatesBetween(
  startedAt: Date,
  finishedAt: Date
): CodexSessionBackfillDate[] {
  const first = toUtcDate(getCodexSessionBackfillDate(startedAt))
  const last = toUtcDate(getCodexSessionBackfillDate(finishedAt))
  // Codex can inherit a different TZ from its shell; probe neighboring calendar dates too.
  first.setUTCDate(first.getUTCDate() - 1)
  last.setUTCDate(last.getUTCDate() + 1)
  return walkCalendarDates(first, last)
}

export function getCodexSessionBackfillScanDates(date = new Date()): CodexSessionBackfillDate[] {
  return getCodexSessionBackfillDatesBetween(date, date)
}

/** Cover unrecorded midnight/crash activity; null requests a full scan when the date range is too wide. */
export function expandCodexSessionBackfillDatesThroughToday(
  dates: readonly CodexSessionBackfillDate[],
  today: CodexSessionBackfillDate,
  maxDates: number
): CodexSessionBackfillDate[] | null {
  if (dates.length === 0) {
    return []
  }
  const current = toUtcDate(today)
  const firstToday = new Date(current)
  firstToday.setUTCDate(firstToday.getUTCDate() - 1)
  current.setUTCDate(current.getUTCDate() + 1)
  const bounds = mergeCodexSessionBackfillDates(dates, walkCalendarDates(firstToday, current))
  const first = toUtcDate(bounds[0])
  const last = toUtcDate(bounds.at(-1)!)
  const dateCount = (last.getTime() - first.getTime()) / 86_400_000 + 1
  if (dateCount > maxDates) {
    return null
  }
  return walkCalendarDates(first, last)
}

function toUtcDate([year, month, day]: readonly string[]): Date {
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
}

// Calendar keys use UTC arithmetic so DST never skips or repeats a directory.
function walkCalendarDates(first: Date, last: Date): CodexSessionBackfillDate[] {
  const dates: CodexSessionBackfillDate[] = []
  const cursor = new Date(first)
  while (cursor <= last) {
    dates.push(formatUtcCalendarDate(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

function formatUtcCalendarDate(date: Date): CodexSessionBackfillDate {
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ]
}
