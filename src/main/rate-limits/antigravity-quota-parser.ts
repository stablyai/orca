import type { RateLimitBucket } from '../../shared/rate-limit-types'

const QUOTA_BUCKETS = {
  'gemini-5h': { name: 'Antigravity 5h', windowMinutes: 300 },
  'gemini-weekly': { name: 'Antigravity weekly', windowMinutes: 10_080 },
  '3p-5h': { name: '3-party 5h', windowMinutes: 300 },
  '3p-weekly': { name: '3-party weekly', windowMinutes: 10_080 }
} as const

type QuotaBucketId = keyof typeof QUOTA_BUCKETS

type RawQuotaBucket = {
  bucketId?: unknown
  remainingFraction?: unknown
  resetTime?: unknown
}

export type AntigravityQuotaBucket = {
  id: QuotaBucketId
  bucket: RateLimitBucket
}

export function parseAntigravityQuotaBuckets(data: unknown): AntigravityQuotaBucket[] {
  const byId = new Map<QuotaBucketId, AntigravityQuotaBucket>()
  for (const raw of collectRawQuotaBuckets(data)) {
    const normalized = normalizeQuotaBucket(raw)
    if (normalized && !byId.has(normalized.id)) {
      byId.set(normalized.id, normalized)
    }
  }
  return (Object.keys(QUOTA_BUCKETS) as QuotaBucketId[])
    .map((id) => byId.get(id))
    .filter((bucket): bucket is AntigravityQuotaBucket => bucket !== undefined)
}

function collectRawQuotaBuckets(data: unknown): RawQuotaBucket[] {
  if (typeof data !== 'object' || data === null) {
    return []
  }
  const value = data as { groups?: unknown; buckets?: unknown }
  const grouped = Array.isArray(value.groups)
    ? value.groups.flatMap((group) => {
        if (typeof group !== 'object' || group === null || !('buckets' in group)) {
          return []
        }
        const buckets = (group as { buckets?: unknown }).buckets
        return Array.isArray(buckets) ? buckets : []
      })
    : []
  const flat = Array.isArray(value.buckets) ? value.buckets : []
  return [...grouped, ...flat].filter(isRawQuotaBucket)
}

function isRawQuotaBucket(value: unknown): value is RawQuotaBucket {
  return typeof value === 'object' && value !== null
}

function normalizeQuotaBucket(raw: RawQuotaBucket): AntigravityQuotaBucket | null {
  if (typeof raw.bucketId !== 'string' || !(raw.bucketId in QUOTA_BUCKETS)) {
    return null
  }
  const id = raw.bucketId as QuotaBucketId
  if (typeof raw.remainingFraction !== 'number' || !Number.isFinite(raw.remainingFraction)) {
    return null
  }
  const resetTime = typeof raw.resetTime === 'string' ? Date.parse(raw.resetTime) : Number.NaN
  const definition = QUOTA_BUCKETS[id]
  return {
    id,
    bucket: {
      name: definition.name,
      usedPercent: Math.round((1 - Math.min(1, Math.max(0, raw.remainingFraction))) * 100),
      windowMinutes: definition.windowMinutes,
      resetsAt: Number.isFinite(resetTime) ? resetTime : null,
      resetDescription: null
    }
  }
}
