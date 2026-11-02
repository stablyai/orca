import type { CodexSessionBackfillDate } from './codex-session-backfill-types'

export function getCodexSessionBackfillDate(date = new Date()): CodexSessionBackfillDate {
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
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
    toCodexSessionBackfillDateKey(getCodexSessionBackfillDate(toUtcDate(value))) === key
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
  const dates: CodexSessionBackfillDate[] = []
  const cursor = toUtcMidnight(startedAt)
  const last = toUtcMidnight(finishedAt)
  while (cursor <= last) {
    dates.push(getCodexSessionBackfillDate(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
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
  const bounds = mergeCodexSessionBackfillDates(dates, [today])
  const first = toUtcDate(bounds[0])
  const last = toUtcDate(bounds.at(-1)!)
  const dateCount = (last.getTime() - first.getTime()) / 86_400_000 + 1
  if (dateCount > maxDates) {
    return null
  }
  return getCodexSessionBackfillDatesBetween(first, last)
}

function toUtcDate([year, month, day]: readonly string[]): Date {
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
}

function toUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}
