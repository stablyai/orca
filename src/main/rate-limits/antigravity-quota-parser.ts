import type { RateLimitBucket, RateLimitWindow } from '../../shared/rate-limit-types'

type AgySummaryBucket = {
  bucketId?: unknown
  remainingFraction?: unknown
  resetTime?: unknown
}

type AgySummaryGroup = {
  buckets?: unknown
}

type AgySummaryResponse = {
  response?: {
    groups?: unknown
  }
}

export type AgyQuotaWindows = {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  buckets: RateLimitBucket[]
}

const AGY_BUCKET_SPECS = {
  'gemini-5h': { name: 'Gemini 5h', windowMinutes: 300 },
  'gemini-weekly': { name: 'Gemini wk', windowMinutes: 10_080 },
  '3p-5h': { name: 'Claude/GPT 5h', windowMinutes: 300 },
  '3p-weekly': { name: 'Claude/GPT wk', windowMinutes: 10_080 }
} as const

const AGY_BUCKET_ORDER = ['gemini-5h', 'gemini-weekly', '3p-5h', '3p-weekly'] as const

type AgyBucketId = (typeof AGY_BUCKET_ORDER)[number]

function isSummaryBucket(value: unknown): value is AgySummaryBucket & { bucketId: AgyBucketId } {
  if (!value || typeof value !== 'object') {
    return false
  }
  const bucket = value as AgySummaryBucket
  return (
    typeof bucket.bucketId === 'string' &&
    Object.hasOwn(AGY_BUCKET_SPECS, bucket.bucketId) &&
    typeof bucket.remainingFraction === 'number' &&
    Number.isFinite(bucket.remainingFraction) &&
    (bucket.resetTime === undefined || typeof bucket.resetTime === 'string')
  )
}

function toBucket(bucket: AgySummaryBucket & { bucketId: AgyBucketId }): RateLimitBucket {
  const spec = AGY_BUCKET_SPECS[bucket.bucketId]
  const remainingFraction = Math.min(1, Math.max(0, bucket.remainingFraction as number))
  const resetsAt = typeof bucket.resetTime === 'string' ? Date.parse(bucket.resetTime) : Number.NaN
  return {
    name: spec.name,
    usedPercent: (1 - remainingFraction) * 100,
    windowMinutes: spec.windowMinutes,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    resetDescription: null
  }
}

function mostConstrainedWindow(
  buckets: RateLimitBucket[],
  windowMinutes: number
): RateLimitWindow | null {
  const matching = buckets.filter((bucket) => bucket.windowMinutes === windowMinutes)
  if (matching.length === 0) {
    return null
  }
  const mostConstrained = matching.reduce((current, candidate) =>
    candidate.usedPercent > current.usedPercent ? candidate : current
  )
  const { name: _name, ...window } = mostConstrained
  return window
}

export function parseAgyQuotaSummary(data: unknown): AgyQuotaWindows | null {
  const groups = (data as AgySummaryResponse | null)?.response?.groups
  if (!Array.isArray(groups)) {
    return null
  }
  const byId = new Map<AgyBucketId, AgySummaryBucket & { bucketId: AgyBucketId }>()
  for (const group of groups) {
    const rawBuckets = (group as AgySummaryGroup | null)?.buckets
    if (!Array.isArray(rawBuckets)) {
      continue
    }
    for (const rawBucket of rawBuckets) {
      if (!isSummaryBucket(rawBucket)) {
        continue
      }
      const current = byId.get(rawBucket.bucketId)
      if (
        !current ||
        (rawBucket.remainingFraction as number) < (current.remainingFraction as number)
      ) {
        byId.set(rawBucket.bucketId, rawBucket)
      }
    }
  }
  const buckets = AGY_BUCKET_ORDER.map((id) => byId.get(id))
    .filter((bucket): bucket is AgySummaryBucket & { bucketId: AgyBucketId } => Boolean(bucket))
    .map(toBucket)
  if (buckets.length === 0) {
    return null
  }
  return {
    session: mostConstrainedWindow(buckets, 300),
    weekly: mostConstrainedWindow(buckets, 10_080),
    buckets
  }
}
