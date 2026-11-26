import type { CodexSessionBackfillBaseline } from './codex-session-backfill-marker'
import type {
  CodexSessionBackfillDate,
  CodexSessionBackfillOptions
} from './codex-session-backfill-types'

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

function toUtcDate([year, month, day]: readonly string[]): Date {
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
}

function formatUtcCalendarDate(date: Date): CodexSessionBackfillDate {
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ]
}

// Launches and recovery share one bounded traversal; only initial baseline certification walks history.
export function resolveCodexSessionBackfillScanPlan(
  baseline: CodexSessionBackfillBaseline | null,
  options: CodexSessionBackfillOptions
): CodexSessionBackfillOptions | null {
  if (!baseline) {
    return {
      boundedScan: options.ignoreCompletionMarker === true || options.boundedScan === true,
      scanFrom: options.scanFrom
    }
  }
  if (
    !options.ignoreCompletionMarker &&
    !baseline.needsScan &&
    !options.fullScanRequired &&
    baseline.hasBaseline
  ) {
    return null
  }
  const requestedFrom = mergeCodexSessionBackfillDates(
    baseline.pendingScanDates,
    baseline.scanFrom ? [baseline.scanFrom] : [],
    options.scanFrom ? [options.scanFrom] : []
  )[0]
  // A cursor without a saved floor belongs to a full-history traversal.
  const scanFrom = baseline.scanCursor
    ? baseline.scanCursorFrom && requestedFrom
      ? mergeCodexSessionBackfillDates([baseline.scanCursorFrom, requestedFrom])[0]
      : undefined
    : requestedFrom
  return {
    boundedScan: true,
    scanFrom:
      options.fullScanRequired || !baseline.hasBaseline || !baseline.scanFrom
        ? undefined
        : scanFrom,
    scanCursor: baseline.scanCursor
  }
}
