import type { RateLimitBucket, RateLimitWindow } from '../../shared/rate-limit-types'

const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10080

export type AntigravityQuotaSummary = {
  buckets: RateLimitBucket[]
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asFiniteFraction(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return null
  }
  return value
}

function remainingFraction(bucket: Record<string, unknown>): number | null {
  const direct =
    asFiniteFraction(bucket.remainingFraction) ?? asFiniteFraction(bucket.remaining_fraction)
  if (direct !== null) {
    return direct
  }
  if (!isRecord(bucket.remaining)) {
    return null
  }
  return (
    asFiniteFraction(bucket.remaining.remainingFraction) ??
    asFiniteFraction(bucket.remaining.remaining_fraction)
  )
}

function resetFields(resetTime: unknown): Pick<RateLimitWindow, 'resetsAt' | 'resetDescription'> {
  if (typeof resetTime !== 'string' || resetTime.length === 0) {
    return { resetsAt: null, resetDescription: null }
  }
  const resetsAt = Date.parse(resetTime)
  if (!Number.isFinite(resetsAt)) {
    return { resetsAt: null, resetDescription: null }
  }
  const date = new Date(resetsAt)
  const isToday = date.toDateString() === new Date().toDateString()
  return {
    resetsAt,
    resetDescription: isToday
      ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : date.toLocaleDateString(undefined, {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit'
        })
  }
}

function isWeeklyBucket(bucketId: string, window: string): boolean {
  return window === 'weekly' || bucketId.includes('weekly')
}

function windowLabel(weekly: boolean): string {
  return weekly ? 'Weekly' : 'Five hour'
}

function toWindow(bucket: RateLimitBucket): RateLimitWindow {
  const { name: _name, ...window } = bucket
  return window
}

function tightest(buckets: RateLimitBucket[]): RateLimitWindow | null {
  if (buckets.length === 0) {
    return null
  }
  return toWindow(
    buckets.reduce((worst, bucket) => (bucket.usedPercent > worst.usedPercent ? bucket : worst))
  )
}

function readGroups(data: unknown): unknown[] {
  if (isRecord(data) && Array.isArray(data.groups)) {
    return data.groups
  }
  if (isRecord(data) && isRecord(data.response) && Array.isArray(data.response.groups)) {
    return data.response.groups
  }
  return []
}

export function parseAntigravityQuotaSummary(data: unknown): AntigravityQuotaSummary | null {
  const buckets: RateLimitBucket[] = []
  for (const groupValue of readGroups(data)) {
    if (!isRecord(groupValue) || !Array.isArray(groupValue.buckets)) {
      continue
    }
    const groupName =
      typeof groupValue.displayName === 'string' && groupValue.displayName.length > 0
        ? groupValue.displayName
        : 'Antigravity'
    for (const bucketValue of groupValue.buckets) {
      if (!isRecord(bucketValue)) {
        continue
      }
      const remaining = remainingFraction(bucketValue)
      if (remaining === null) {
        continue
      }
      const bucketId = typeof bucketValue.bucketId === 'string' ? bucketValue.bucketId : ''
      const window = typeof bucketValue.window === 'string' ? bucketValue.window : ''
      const weekly = isWeeklyBucket(bucketId, window)
      buckets.push({
        name: `${groupName} · ${windowLabel(weekly)}`,
        usedPercent: Math.min(100, Math.max(0, Math.round((1 - remaining) * 100))),
        windowMinutes: weekly ? WEEKLY_WINDOW_MINUTES : SESSION_WINDOW_MINUTES,
        ...resetFields(bucketValue.resetTime)
      })
    }
  }
  if (buckets.length === 0) {
    return null
  }
  return {
    buckets,
    session: tightest(buckets.filter((bucket) => bucket.windowMinutes === SESSION_WINDOW_MINUTES)),
    weekly: tightest(buckets.filter((bucket) => bucket.windowMinutes === WEEKLY_WINDOW_MINUTES))
  }
}
