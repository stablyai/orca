import type { RateLimitBucket } from '../../shared/rate-limit-types'

export const CURSOR_MODELS_BUCKET = 'Cursor Models'
export const CURSOR_OTHER_BUCKET = 'Other Models'
export const CURSOR_GROK_BOT_BUCKET = 'Grok Bot'

export type CursorUsageSummary = {
  billingCycleStart?: unknown
  billingCycleEnd?: unknown
  membershipType?: unknown
  individualUsage?: {
    plan?: { autoPercentUsed?: unknown; apiPercentUsed?: unknown }
    onDemand?: { enabled?: unknown; used?: unknown; limit?: unknown }
  }
}

export type CursorSandUsage = {
  usagePercent?: unknown
  currentPeriodStart?: unknown
  nextResetTimestampUtc?: unknown
  hasNonZeroIncludedLimit?: unknown
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  if (/^\d+$/.test(value.trim())) {
    return parseTimestampMs(Number(value))
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function bucket(
  name: string,
  usedPercent: number,
  startMs: number | null,
  endMs: number | null
): RateLimitBucket {
  const windowMinutes =
    startMs !== null && endMs !== null && endMs > startMs
      ? Math.max(1, Math.round((endMs - startMs) / 60_000))
      : undefined
  return {
    name,
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    resetsAt: endMs,
    resetDescription: null
  }
}

export function mapCursorUsageSummary(data: CursorUsageSummary): {
  buckets: RateLimitBucket[]
  planType: string | null
} {
  const plan = data.individualUsage?.plan
  const startMs = parseTimestampMs(data.billingCycleStart)
  const endMs = parseTimestampMs(data.billingCycleEnd)
  const buckets: RateLimitBucket[] = []
  const cursorModels = parseFiniteNumber(plan?.autoPercentUsed)
  if (cursorModels !== null) {
    buckets.push(bucket(CURSOR_MODELS_BUCKET, cursorModels, startMs, endMs))
  }
  const otherModels = parseFiniteNumber(plan?.apiPercentUsed)
  if (otherModels !== null) {
    buckets.push(bucket(CURSOR_OTHER_BUCKET, otherModels, startMs, endMs))
  }

  const onDemand = data.individualUsage?.onDemand
  if (onDemand?.enabled === true) {
    const used = parseFiniteNumber(onDemand.used)
    const limit = parseFiniteNumber(onDemand.limit)
    if (used !== null && limit !== null && limit > 0) {
      buckets.push(bucket('On-demand', (used / limit) * 100, startMs, endMs))
    }
  }

  const membership = data.membershipType
  return {
    buckets,
    planType: typeof membership === 'string' && membership.trim() ? membership.trim() : null
  }
}

export function mapCursorSandUsage(data: CursorSandUsage): RateLimitBucket | null {
  if (data.hasNonZeroIncludedLimit === false) {
    return null
  }
  const usedPercent = parseFiniteNumber(data.usagePercent)
  if (usedPercent === null) {
    return null
  }
  return bucket(
    CURSOR_GROK_BOT_BUCKET,
    usedPercent,
    parseTimestampMs(data.currentPeriodStart),
    parseTimestampMs(data.nextResetTimestampUtc)
  )
}
