import type { RateLimitBucket, RateLimitWindow } from '../../shared/rate-limit-types'

const MODEL_ID_TO_BUCKET_NAME: Record<string, string> = {
  'gemini-3.1-pro': '3.1 Pro',
  'gemini-3.1-flash': '3.1 Flash',
  'gemini-3.1-flash-lite': '3.1 Flash Lite',
  'gemini-3.0-pro': '3.0 Pro',
  'gemini-3.0-flash': '3.0 Flash',
  'gemini-2.5-pro': 'Pro',
  'gemini-2.5-flash': 'Flash',
  'gemini-2.5-flash-lite': 'Flash Lite',
  'gemini-2.0-pro': '2.0 Pro',
  'gemini-2.0-flash': '2.0 Flash',
  'gemini-2.0-flash-lite': '2.0 Flash Lite',
  'gemini-1.5-pro': '1.5 Pro',
  'gemini-1.5-flash': '1.5 Flash',
  'gemini-exp': 'Exp',
  'gemini-experimental': 'Exp'
}

function humanizeModelId(modelId: string): string {
  const withoutPrefix = modelId.replace(/^gemini-/i, '')
  return withoutPrefix
    .split('-')
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ')
}

export function getBucketName(modelId: string): string {
  return MODEL_ID_TO_BUCKET_NAME[modelId] ?? humanizeModelId(modelId)
}

export function buildRateLimitBucket(b: {
  remainingFraction: number
  resetTime: string
  modelId: string
}): RateLimitBucket {
  const usedPercent = Math.min(100, Math.max(0, Math.round((1 - b.remainingFraction) * 100)))
  const resetsAtTime = new Date(b.resetTime).getTime()
  return {
    name: getBucketName(b.modelId),
    usedPercent,
    windowMinutes: 60,
    resetsAt: !isNaN(resetsAtTime) ? resetsAtTime : null,
    resetDescription: null
  }
}

export function deduplicateBuckets(
  buckets: (RateLimitBucket & { modelId: string })[]
): RateLimitBucket[] {
  const result: (RateLimitBucket & { modelId: string })[] = []
  const seenKeys = new Map<string, number>()
  for (const b of buckets) {
    const key = `${b.usedPercent}-${b.resetsAt}`
    const existingIndex = seenKeys.get(key)
    if (existingIndex === undefined) {
      seenKeys.set(key, result.length)
      result.push(b)
      continue
    }
    const existing = result[existingIndex]!
    const existingInMap = existing.modelId in MODEL_ID_TO_BUCKET_NAME
    const currentInMap = b.modelId in MODEL_ID_TO_BUCKET_NAME
    if (
      (currentInMap && !existingInMap) ||
      (currentInMap === existingInMap && b.name.length < existing.name.length)
    ) {
      result[existingIndex] = b
    }
  }
  return result.map(({ modelId: _id, ...rest }) => rest)
}

export function deriveSessionSummary(buckets: RateLimitBucket[]): RateLimitWindow | null {
  if (buckets.length === 0) {
    return null
  }
  const mostConstrained = buckets.reduce((worst, bucket) => {
    return bucket.usedPercent > worst.usedPercent ? bucket : worst
  })
  const { name: _name, ...window } = mostConstrained
  return window
}
