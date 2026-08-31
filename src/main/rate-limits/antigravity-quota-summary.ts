import type { RateLimitBucket, RateLimitWindow } from '../../shared/rate-limit-types'

/**
 * Shape of `RetrieveUserQuotaSummaryResponse` as the Antigravity LanguageServer serialises it
 * (Connect JSON, lowerCamelCase). `response.groups` holds "Gemini Models" and "Claude and GPT
 * models", each with its own five-hour and weekly bucket and independent reset.
 */
type RawBucket = {
  bucketId?: unknown
  bucket_id?: unknown
  displayName?: unknown
  display_name?: unknown
  window?: unknown
  remainingFraction?: unknown
  remaining_fraction?: unknown
  disabled?: unknown
  resetTime?: unknown
  reset_time?: unknown
}

export const SESSION_WINDOW_MINUTES = 300
export const WEEKLY_WINDOW_MINUTES = 10080

export type AntigravityQuotaSummary = {
  buckets: RateLimitBucket[]
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }
  return ''
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return null
}

function classifyWindowMinutes(...hints: string[]): number | null {
  const haystack = hints.join(' ').toLowerCase()
  if (/\bweek|weekly|\bwk\b|7d/.test(haystack)) {
    return WEEKLY_WINDOW_MINUTES
  }
  if (/5h|five[\s_-]*hour|5[\s_-]*hour/.test(haystack)) {
    return SESSION_WINDOW_MINUTES
  }
  return null
}

function windowSuffix(windowMinutes: number): string {
  return windowMinutes === WEEKLY_WINDOW_MINUTES ? '7d' : '5h'
}

function toBucket(raw: RawBucket, groupName: string): RateLimitBucket | null {
  if (raw.disabled === true) {
    return null
  }
  const remainingFraction = firstFiniteNumber(raw.remainingFraction, raw.remaining_fraction)
  if (remainingFraction === null) {
    return null
  }
  const bucketId = firstString(raw.bucketId, raw.bucket_id)
  const displayName = firstString(raw.displayName, raw.display_name)
  const windowHint = firstString(raw.window)
  const windowMinutes = classifyWindowMinutes(bucketId, windowHint, displayName)
  if (windowMinutes === null) {
    return null
  }
  const resetTime = firstString(raw.resetTime, raw.reset_time)
  const resetsAt = resetTime ? Date.parse(resetTime) : Number.NaN
  return {
    // Why: the group carries the product identity ("Gemini Models"), the bucket only the window.
    name: `${groupName || displayName || bucketId} · ${windowSuffix(windowMinutes)}`,
    usedPercent: Math.min(100, Math.max(0, Math.round((1 - remainingFraction) * 100))),
    windowMinutes,
    resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
    resetDescription: null
  }
}

/** The tightest bucket in a window is the one that will actually stop the user first. */
function mostConstrained(
  buckets: RateLimitBucket[],
  windowMinutes: number
): RateLimitWindow | null {
  const candidates = buckets.filter((bucket) => bucket.windowMinutes === windowMinutes)
  if (candidates.length === 0) {
    return null
  }
  const worst = candidates.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a))
  const { name: _name, ...window } = worst
  return window
}

/** Returns null when the payload carries no readable bucket, so callers can report that distinctly. */
export function parseAntigravityQuotaSummary(data: unknown): AntigravityQuotaSummary | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const response = (data as { response?: unknown }).response
  const responseGroups =
    typeof response === 'object' && response !== null
      ? (response as { groups?: unknown }).groups
      : undefined
  const groups = Array.isArray(responseGroups)
    ? responseGroups
    : (data as { buckets?: unknown }).buckets
  if (!Array.isArray(groups)) {
    return null
  }
  const buckets: RateLimitBucket[] = []
  for (const group of groups) {
    if (typeof group !== 'object' || group === null) {
      continue
    }
    const groupName = firstString(
      (group as RawBucket).displayName,
      (group as RawBucket).display_name
    )
    const groupBuckets = (group as { buckets?: unknown }).buckets
    if (!Array.isArray(groupBuckets)) {
      continue
    }
    for (const rawBucket of groupBuckets) {
      if (typeof rawBucket !== 'object' || rawBucket === null) {
        continue
      }
      const bucket = toBucket(rawBucket as RawBucket, groupName)
      if (bucket) {
        buckets.push(bucket)
      }
    }
  }
  if (buckets.length === 0) {
    return null
  }
  return {
    buckets,
    session: mostConstrained(buckets, SESSION_WINDOW_MINUTES),
    weekly: mostConstrained(buckets, WEEKLY_WINDOW_MINUTES)
  }
}
