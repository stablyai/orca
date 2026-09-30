import {
  ANTIGRAVITY_FIVE_HOUR_MINUTES,
  ANTIGRAVITY_WEEKLY_MINUTES,
  getAntigravitySummaryBuckets
} from '../../shared/antigravity-usage-windows'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow
} from '../../shared/rate-limit-types'

// Why: `agy -p /quota` prints one TAB-separated row per window:
//   <family>\t<window label>\t<remaining %>\t<ISO reset time>
const QUOTA_ROW_FIELD_COUNT = 4

export type AntigravityQuotaRow = {
  family: string
  windowMinutes: number
  /** Percentage of the window already consumed (0-100). */
  usedPercent: number
  resetsAt: number | null
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function windowMinutesForLabel(label: string): number | null {
  if (/five hour/i.test(label)) {
    return ANTIGRAVITY_FIVE_HOUR_MINUTES
  }
  if (/weekly/i.test(label)) {
    return ANTIGRAVITY_WEEKLY_MINUTES
  }
  return null
}

function shortWindowLabel(windowMinutes: number): string {
  return windowMinutes === ANTIGRAVITY_WEEKLY_MINUTES ? 'Weekly' : '5h'
}

function toWindow(row: AntigravityQuotaRow): RateLimitWindow {
  return {
    usedPercent: row.usedPercent,
    windowMinutes: row.windowMinutes,
    resetsAt: row.resetsAt,
    resetDescription: null
  }
}

// Why: a non-interactive slash-command read, not a model turn, so unmatched lines (startup
// notices, errors) are skipped rather than guessed at.
export function parseAntigravityQuotaRows(stdout: string): AntigravityQuotaRow[] {
  const rows: AntigravityQuotaRow[] = []
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split('\t')
    if (fields.length !== QUOTA_ROW_FIELD_COUNT) {
      continue
    }
    const [family, label, remainingField, resetField] = fields.map((field) => field.trim())
    if (!family || !label) {
      continue
    }
    const windowMinutes = windowMinutesForLabel(label)
    if (windowMinutes === null) {
      continue
    }
    const remainingPercent = Number.parseFloat(remainingField.replace(/%$/, ''))
    if (!Number.isFinite(remainingPercent)) {
      continue
    }
    const resetsAtMs = Date.parse(resetField)
    rows.push({
      family,
      windowMinutes,
      usedPercent: Math.round(clampPercent(100 - remainingPercent)),
      resetsAt: Number.isNaN(resetsAtMs) ? null : resetsAtMs
    })
  }
  return rows
}

export function buildAntigravityRateLimits(
  rows: AntigravityQuotaRow[],
  updatedAt = Date.now()
): ProviderRateLimits {
  const buckets: RateLimitBucket[] = rows.map((row) => ({
    name: `${row.family} · ${shortWindowLabel(row.windowMinutes)}`,
    ...toWindow(row)
  }))
  const [session] = getAntigravitySummaryBuckets(buckets)
  return {
    provider: 'antigravity',
    session: session ?? null,
    // Why: both families' weekly windows live in buckets; the tooltip renders them there.
    weekly: null,
    buckets,
    updatedAt,
    error: null,
    status: 'ok'
  }
}
