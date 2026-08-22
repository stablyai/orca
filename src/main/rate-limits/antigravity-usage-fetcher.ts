import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow
} from '../../shared/rate-limit-types'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'

const AGY_USAGE_ARGS = [
  '-p',
  '/usage',
  '--output-format',
  'json',
  '--print-timeout',
  '20s'
] as const
const AGY_PROCESS_TIMEOUT_MS = 25_000

const AGY_BUCKETS = {
  'gemini-weekly': { name: 'Gemini weekly', windowMinutes: 10_080 },
  'gemini-5h': { name: 'Gemini 5h', windowMinutes: 300 },
  '3p-weekly': { name: 'Claude/GPT weekly', windowMinutes: 10_080 },
  '3p-5h': { name: 'Claude/GPT 5h', windowMinutes: 300 }
} as const

type AgyBucketId = keyof typeof AGY_BUCKETS

type AgyUsageBucket = {
  id: AgyBucketId
  remainingFraction: number
  resetTime: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseResetTime(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function parseAgyBucket(value: unknown): AgyUsageBucket | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !(value.id in AGY_BUCKETS)) {
    return null
  }
  if (typeof value.remaining_fraction !== 'number' || !Number.isFinite(value.remaining_fraction)) {
    return null
  }
  return {
    id: value.id as AgyBucketId,
    remainingFraction: value.remaining_fraction,
    resetTime: parseResetTime(value.reset_time)
  }
}

function toRateLimitBucket(bucket: AgyUsageBucket): RateLimitBucket {
  const definition = AGY_BUCKETS[bucket.id]
  const remainingFraction = Math.min(1, Math.max(0, bucket.remainingFraction))
  const resetsAt = bucket.resetTime ? Date.parse(bucket.resetTime) : Number.NaN
  return {
    name: definition.name,
    usedPercent: Math.round((1 - remainingFraction) * 100),
    windowMinutes: definition.windowMinutes,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    resetDescription: null
  }
}

function tightestWindow(buckets: RateLimitBucket[], windowMinutes: number): RateLimitWindow | null {
  const matches = buckets.filter((bucket) => bucket.windowMinutes === windowMinutes)
  if (matches.length === 0) {
    return null
  }
  const tightest = matches.reduce((current, candidate) =>
    candidate.usedPercent > current.usedPercent ? candidate : current
  )
  const { name: _name, ...window } = tightest
  return window
}

export function parseAntigravityUsageOutput(output: string): RateLimitBucket[] {
  const parsed: unknown = JSON.parse(output)
  if (!isRecord(parsed) || parsed.status !== 'SUCCESS' || !isRecord(parsed.command)) {
    throw new Error('Agy returned an invalid usage response')
  }
  if (parsed.command.name !== 'usage' || !isRecord(parsed.command.data)) {
    throw new Error('Agy did not return usage data')
  }
  const groups = parsed.command.data.groups
  if (!Array.isArray(groups)) {
    throw new Error('Agy usage groups are missing')
  }

  const discovered = new Map<AgyBucketId, AgyUsageBucket>()
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) {
      continue
    }
    for (const rawBucket of group.buckets) {
      const bucket = parseAgyBucket(rawBucket)
      if (bucket && !discovered.has(bucket.id)) {
        discovered.set(bucket.id, bucket)
      }
    }
  }

  const buckets = (Object.keys(AGY_BUCKETS) as AgyBucketId[])
    .map((id) => discovered.get(id))
    .filter((bucket): bucket is AgyUsageBucket => bucket !== undefined)
    .map(toRateLimitBucket)
  if (buckets.length === 0) {
    throw new Error('Agy returned no recognized usage buckets')
  }
  return buckets
}

function makeResult(
  status: ProviderRateLimits['status'],
  error: string,
  failureKind: NonNullable<ProviderRateLimits['usageMetadata']>['failureKind']
): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    buckets: [],
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: {
      source: 'cli',
      attemptedSources: ['cli'],
      failureKind
    }
  }
}

export async function fetchAntigravityRateLimits(options?: {
  signal?: AbortSignal
}): Promise<ProviderRateLimits> {
  let result
  try {
    result = await runProcess({
      program: resolveCliCommand('agy'),
      args: AGY_USAGE_ARGS,
      timeoutMs: AGY_PROCESS_TIMEOUT_MS,
      maxOutputBytes: 1024 * 1024,
      signal: options?.signal
    })
  } catch (error) {
    const unavailable = isRecord(error) && error.code === 'ENOENT'
    return makeResult(
      unavailable ? 'unavailable' : 'error',
      unavailable ? 'Antigravity CLI not found' : 'Agy usage command could not start',
      unavailable ? 'cli-unavailable' : 'unknown'
    )
  }

  if (result.timedOut) {
    return makeResult('error', 'Agy usage request timed out', 'usage-unavailable')
  }
  if (result.code !== 0) {
    return makeResult(
      'error',
      `Agy usage command failed (exit code ${result.code ?? 'unknown'})`,
      'usage-unavailable'
    )
  }

  let buckets: RateLimitBucket[]
  try {
    buckets = parseAntigravityUsageOutput(result.stdout)
  } catch (error) {
    return makeResult(
      'error',
      error instanceof Error ? error.message : 'Agy returned invalid usage data',
      'parse'
    )
  }

  return {
    provider: 'antigravity',
    session: tightestWindow(buckets, 300),
    // Detailed views read the independent weekly identities from buckets.
    weekly: null,
    buckets,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: {
      source: 'cli',
      attemptedSources: ['cli']
    }
  }
}
