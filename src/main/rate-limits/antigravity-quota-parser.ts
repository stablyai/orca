import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow
} from '../../shared/rate-limit-types'

type AntigravityBucketSpec = {
  name: string
  windowMinutes: number
}

const ANTIGRAVITY_BUCKET_SPECS: Record<string, AntigravityBucketSpec> = {
  'gemini-5h': { name: 'Gemini 5h', windowMinutes: 300 },
  'gemini-weekly': { name: 'Gemini wk', windowMinutes: 10_080 },
  '3p-5h': { name: 'Claude/GPT 5h', windowMinutes: 300 },
  '3p-weekly': { name: 'Claude/GPT wk', windowMinutes: 10_080 }
}

const ANTIGRAVITY_BUCKET_ORDER = ['gemini-5h', 'gemini-weekly', '3p-5h', '3p-weekly']

type ParsedQuotaBucket = {
  bucketId: string
  remainingFraction: number
  resetTime: string | null
}

/** Accepts the response envelopes emitted by current and earlier AGY runtimes. */
function quotaGroups(value: unknown): unknown[] | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const root = value as { groups?: unknown; response?: { groups?: unknown } }
  const groups = root.response?.groups ?? root.groups
  return Array.isArray(groups) ? groups : null
}

/** Rejects malformed quota entries before they can affect UI percentages. */
function parseQuotaBucket(value: unknown): ParsedQuotaBucket | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const bucket = value as Record<string, unknown>
  if (
    typeof bucket.bucketId !== 'string' ||
    typeof bucket.remainingFraction !== 'number' ||
    !Number.isFinite(bucket.remainingFraction) ||
    (bucket.resetTime !== undefined &&
      bucket.resetTime !== null &&
      typeof bucket.resetTime !== 'string')
  ) {
    return null
  }
  return {
    bucketId: bucket.bucketId,
    remainingFraction: bucket.remainingFraction,
    resetTime: typeof bucket.resetTime === 'string' ? bucket.resetTime : null
  }
}

/** Keeps only known identities and the safest value for duplicate entries. */
function collectQuotaBuckets(groups: unknown[]): Map<string, ParsedQuotaBucket> {
  const buckets = new Map<string, ParsedQuotaBucket>()
  for (const value of groups) {
    if (!value || typeof value !== 'object') {
      continue
    }
    const rawBuckets = (value as { buckets?: unknown }).buckets
    if (!Array.isArray(rawBuckets)) {
      continue
    }
    for (const rawBucket of rawBuckets) {
      const bucket = parseQuotaBucket(rawBucket)
      if (bucket && Object.hasOwn(ANTIGRAVITY_BUCKET_SPECS, bucket.bucketId)) {
        const current = buckets.get(bucket.bucketId)
        // Why: duplicate identities are ambiguous; keeping the lower remaining
        // value avoids quietly understating usage from a malformed response.
        if (!current || bucket.remainingFraction < current.remainingFraction) {
          buckets.set(bucket.bucketId, bucket)
        }
      }
    }
  }
  return buckets
}

/** Normalizes AGY fractions and reset timestamps into Orca's shared model. */
function toRateLimitBucket(bucket: ParsedQuotaBucket): RateLimitBucket {
  const spec = ANTIGRAVITY_BUCKET_SPECS[bucket.bucketId]!
  const remainingFraction = Math.min(1, Math.max(0, bucket.remainingFraction))
  const resetsAt = bucket.resetTime ? Date.parse(bucket.resetTime) : Number.NaN
  return {
    name: spec.name,
    usedPercent: Math.round((1 - remainingFraction) * 100),
    windowMinutes: spec.windowMinutes,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    resetDescription: null
  }
}

/** Derives compatibility summaries without discarding the four detailed buckets. */
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

/** Maps AGY's two quota families into the current Detailed/Compact bucket model. */
export function parseAntigravityQuotaSummary(
  value: unknown,
  updatedAt = Date.now()
): ProviderRateLimits | null {
  const groups = quotaGroups(value)
  if (!groups) {
    return null
  }
  const rawBuckets = collectQuotaBuckets(groups)
  const buckets = ANTIGRAVITY_BUCKET_ORDER.map((id) => rawBuckets.get(id))
    .filter((bucket): bucket is ParsedQuotaBucket => bucket !== undefined)
    .map(toRateLimitBucket)
  if (buckets.length === 0) {
    return null
  }
  return {
    provider: 'antigravity',
    // Why: summary windows keep non-roster consumers useful; Detailed renders
    // the four named buckets and Compact independently selects their tightest.
    session: mostConstrainedWindow(buckets, 300),
    weekly: mostConstrainedWindow(buckets, 10_080),
    buckets,
    updatedAt,
    error: null,
    status: 'ok'
  }
}
