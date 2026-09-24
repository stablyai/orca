import { z } from 'zod'
import {
  CURSOR_MODELS_BUCKET_NAME,
  CURSOR_ON_DEMAND_BUCKET_NAME,
  CURSOR_OTHER_MODELS_BUCKET_NAME
} from '../../shared/cursor-usage-buckets'
import type { RateLimitBucket, RateLimitWindow } from '../../shared/rate-limit-types'

const MONTHLY_WINDOW_MINUTES = 43_200

const cursorPoolSchema = z
  .object({
    enabled: z.unknown(),
    used: z.unknown(),
    limit: z.unknown(),
    totalPercentUsed: z.unknown(),
    autoPercentUsed: z.unknown(),
    apiPercentUsed: z.unknown()
  })
  .partial()

const cursorUsageSummarySchema = z
  .object({
    billingCycleStart: z.unknown(),
    billingCycleEnd: z.unknown(),
    membershipType: z.unknown(),
    isUnlimited: z.unknown(),
    individualUsage: z
      .object({ plan: cursorPoolSchema.optional(), onDemand: cursorPoolSchema.optional() })
      .partial()
      .optional()
  })
  .partial()

type CursorPool = z.infer<typeof cursorPoolSchema>
export type CursorUsageSummary = z.infer<typeof cursorUsageSummarySchema>

/** Accepts the raw dashboard body; an unrecognised shape maps to "nothing reported". */
export function parseCursorUsageSummary(data: unknown): CursorUsageSummary {
  const parsed = cursorUsageSummarySchema.safeParse(data)
  return parsed.success ? parsed.data : {}
}

export type CursorUsageMapping = {
  monthly: RateLimitWindow | null
  buckets: RateLimitBucket[]
  planType: string | null
  isUnlimited: boolean
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseCursorTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Why: Cursor mixes epoch seconds and milliseconds across billing fields.
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    return parseCursorTimestampMs(Number(trimmed))
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function resetDescription(resetsAtMs: number | null): string | null {
  if (resetsAtMs === null) {
    return null
  }
  const date = new Date(resetsAtMs)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function windowMinutesFor(startMs: number | null, endMs: number | null): number {
  if (startMs === null || endMs === null || endMs <= startMs) {
    return MONTHLY_WINDOW_MINUTES
  }
  return Math.max(1, Math.round((endMs - startMs) / 60_000))
}

/**
 * Percent consumed for one pool. `used / limit` wins over the sibling percentage
 * fields: the raw pair is internally consistent, while the percentages are
 * pre-rounded for the dashboard's own copy and disagree with it on real accounts.
 */
function poolPercent(pool: CursorPool | undefined, percentField: keyof CursorPool): number | null {
  if (!pool) {
    return null
  }
  const used = finiteNumber(pool.used)
  const limit = finiteNumber(pool.limit)
  if (used !== null && limit !== null && limit > 0) {
    return (used / limit) * 100
  }
  return finiteNumber(pool[percentField])
}

export function mapCursorUsageSummary(summary: CursorUsageSummary): CursorUsageMapping {
  const startMs = parseCursorTimestampMs(summary.billingCycleStart)
  const endMs = parseCursorTimestampMs(summary.billingCycleEnd)
  const windowMinutes = windowMinutesFor(startMs, endMs)
  const description = resetDescription(endMs)
  const toWindow = (percent: number): RateLimitWindow => ({
    usedPercent: clampPercent(percent),
    windowMinutes,
    resetsAt: endMs,
    resetDescription: description
  })

  const plan = summary.individualUsage?.plan
  // Why: a team-billed account still reports 0% pools it does not own. Publishing
  // them as buckets would paint a healthy 0% meter and skip the legacy fallback.
  const planEnabled = plan?.enabled !== false
  const buckets: RateLimitBucket[] = []
  const cursorModels = planEnabled ? finiteNumber(plan?.autoPercentUsed) : null
  if (cursorModels !== null) {
    buckets.push({ name: CURSOR_MODELS_BUCKET_NAME, ...toWindow(cursorModels) })
  }
  const otherModels = planEnabled ? finiteNumber(plan?.apiPercentUsed) : null
  if (otherModels !== null) {
    buckets.push({ name: CURSOR_OTHER_MODELS_BUCKET_NAME, ...toWindow(otherModels) })
  }

  const onDemand = summary.individualUsage?.onDemand
  const onDemandPercent =
    onDemand?.enabled === true ? poolPercent(onDemand, 'totalPercentUsed') : null
  if (onDemandPercent !== null) {
    buckets.push({ name: CURSOR_ON_DEMAND_BUCKET_NAME, ...toWindow(onDemandPercent) })
  }

  const planPercent = planEnabled ? poolPercent(plan, 'totalPercentUsed') : null
  const membership = summary.membershipType
  return {
    monthly: planPercent === null ? null : toWindow(planPercent),
    buckets,
    planType: typeof membership === 'string' && membership.trim() ? membership.trim() : null,
    isUnlimited: summary.isUnlimited === true
  }
}

/**
 * Advances a cycle start by one month in UTC, clamping the day so a Jan 31 start
 * lands on Feb 28/29 instead of overflowing into March.
 */
function addOneMonthUtc(startMs: number): number {
  const start = new Date(startMs)
  const year = start.getUTCFullYear()
  const month = start.getUTCMonth()
  const lastDayOfNextMonth = new Date(Date.UTC(year, month + 2, 0)).getUTCDate()
  return Date.UTC(
    year,
    month + 1,
    Math.min(start.getUTCDate(), lastDayOfNextMonth),
    start.getUTCHours(),
    start.getUTCMinutes(),
    start.getUTCSeconds(),
    start.getUTCMilliseconds()
  )
}

const legacyBucketSchema = z
  .object({ numRequests: z.unknown(), maxRequestUsage: z.unknown() })
  .partial()

const legacyQuotaSchema = z.record(z.string(), z.union([legacyBucketSchema, z.unknown()]))

/**
 * Request-quota plans predate spend-based billing and report a per-model ceiling
 * instead of a cents allowance, so those accounts still get a bar.
 */
export function mapCursorLegacyRequestQuota(payload: unknown): RateLimitWindow | null {
  const parsed = legacyQuotaSchema.safeParse(payload)
  if (!parsed.success) {
    return null
  }
  const quotas: { name: string; used: number; limit: number }[] = []
  for (const [name, value] of Object.entries(parsed.data)) {
    const entry = legacyBucketSchema.safeParse(value)
    if (!entry.success) {
      continue
    }
    const limit = finiteNumber(entry.data.maxRequestUsage)
    const used = finiteNumber(entry.data.numRequests)
    if (limit === null || limit <= 0 || used === null) {
      continue
    }
    quotas.push({ name, used, limit })
  }
  if (quotas.length === 0) {
    return null
  }
  // Why: 'gpt-4' is the premium bucket on legacy plans; otherwise the largest
  // ceiling is the headline quota on every shape seen so far.
  const quota =
    quotas.find((entry) => entry.name === 'gpt-4') ??
    quotas.sort((left, right) => right.limit - left.limit)[0]
  if (!quota) {
    return null
  }

  const startOfMonth = parseCursorTimestampMs(parsed.data.startOfMonth)
  const resetsAt = startOfMonth === null ? null : addOneMonthUtc(startOfMonth)
  return {
    usedPercent: clampPercent((quota.used / quota.limit) * 100),
    windowMinutes: MONTHLY_WINDOW_MINUTES,
    resetsAt,
    resetDescription: resetDescription(resetsAt)
  }
}
