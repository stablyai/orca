import { net } from 'electron'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow
} from '../../shared/rate-limit-types'
import { readCursorAuthSession, type CursorAuthReadResult } from './cursor-auth'
import { parseClaudeUsageResetTimestamp } from './claude-usage-window'

// Why: this is the same Connect RPC endpoint Cursor's own dashboard/status bar reads.
const DASHBOARD_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'
const API_TIMEOUT_MS = 10_000
const MONTHLY_WINDOW_MINUTES = 43_200

type CursorPlanUsage = {
  totalPercentUsed?: unknown
  autoPercentUsed?: unknown
  apiPercentUsed?: unknown
}

type CursorDashboardResponse = {
  planUsage?: CursorPlanUsage
  billingCycleStart?: unknown
  billingCycleEnd?: unknown
  planType?: unknown
  plan?: unknown
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  extra?: Partial<ProviderRateLimits>
): ProviderRateLimits {
  return {
    provider: 'cursor',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...extra
  }
}

/** Accepts an ISO date string, epoch seconds, or epoch milliseconds. */
function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' || typeof value === 'string') {
    return parseClaudeUsageResetTimestamp(value)
  }
  return null
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function computeWindowMinutes(startMs: number | null, endMs: number | null): number {
  if (startMs === null || endMs === null) {
    return MONTHLY_WINDOW_MINUTES
  }
  const diffMinutes = (endMs - startMs) / 60_000
  return diffMinutes > 0 ? diffMinutes : MONTHLY_WINDOW_MINUTES
}

// Why: same style as Grok's parseResetDescription, adapted to accept an
// already-parsed epoch ms since Cursor's billingCycleEnd may be a numeric string.
function parseResetDescription(resetsAtMs: number | null): string | null {
  if (resetsAtMs === null) {
    return null
  }
  const date = new Date(resetsAtMs)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function extractPlanType(data: CursorDashboardResponse): string | undefined {
  const candidate = data.planType ?? data.plan
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

function buildBuckets(
  usage: CursorPlanUsage,
  resetsAt: number | null,
  resetDescription: string | null,
  windowMinutes: number
): RateLimitBucket[] | undefined {
  const buckets: RateLimitBucket[] = []
  const autoPercent = toFiniteNumber(usage.autoPercentUsed)
  if (autoPercent !== null) {
    buckets.push({
      name: 'Cursor Models',
      usedPercent: clampPercent(autoPercent),
      windowMinutes,
      resetsAt,
      resetDescription
    })
  }
  const apiPercent = toFiniteNumber(usage.apiPercentUsed)
  if (apiPercent !== null) {
    buckets.push({
      name: 'Other models',
      usedPercent: clampPercent(apiPercent),
      windowMinutes,
      resetsAt,
      resetDescription
    })
  }
  return buckets.length > 0 ? buckets : undefined
}

// Why: 'ide' auth comes from the Cursor IDE's own web-authenticated session,
// while 'cli' comes from `cursor-agent`; UsageRateLimitSource has no 'ide' value.
function toUsageMetadataSource(authSource: 'cli' | 'ide'): 'cli' | 'web' {
  return authSource === 'ide' ? 'web' : 'cli'
}

function parseFailure(source: 'cli' | 'web'): ProviderRateLimits {
  return result('error', 'Cursor usage response could not be parsed', {
    usageMetadata: { failureKind: 'parse', source }
  })
}

function mapDashboardResponse(
  data: CursorDashboardResponse,
  source: 'cli' | 'web'
): ProviderRateLimits {
  const usage = data.planUsage
  const totalPercent = toFiniteNumber(usage?.totalPercentUsed)
  if (!usage || totalPercent === null) {
    return parseFailure(source)
  }

  const startMs = parseTimestamp(data.billingCycleStart)
  const endMs = parseTimestamp(data.billingCycleEnd)
  const windowMinutes = computeWindowMinutes(startMs, endMs)
  const resetDescription = parseResetDescription(endMs)
  const monthly: RateLimitWindow = {
    usedPercent: clampPercent(totalPercent),
    windowMinutes,
    resetsAt: endMs,
    resetDescription
  }
  const buckets = buildBuckets(usage, endMs, resetDescription, windowMinutes)
  const planType = extractPlanType(data)

  return {
    provider: 'cursor',
    session: null,
    weekly: null,
    monthly,
    ...(buckets ? { buckets } : {}),
    ...(planType !== undefined ? { planType } : {}),
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source }
  }
}

// Why: Orca never runs `cursor-agent login`; it only reads the token the CLI
// or Cursor IDE already established (see cursor-auth.ts).
export async function fetchCursorRateLimits(
  options: { signal?: AbortSignal; authReadResult?: CursorAuthReadResult } = {}
): Promise<ProviderRateLimits> {
  const authResult = options.authReadResult ?? (await readCursorAuthSession())
  if (authResult.status === 'missing') {
    return result('unavailable', 'Not signed in to Cursor — run cursor-agent and sign in', {
      usageMetadata: { failureKind: 'missing-credentials', source: 'cli' }
    })
  }
  if (authResult.status === 'error') {
    return result('error', authResult.error, {
      usageMetadata: { failureKind: 'unknown', source: 'cli' }
    })
  }

  const source = toUsageMetadataSource(authResult.source)

  try {
    const requestSignal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(API_TIMEOUT_MS)])
      : AbortSignal.timeout(API_TIMEOUT_MS)
    const res = await net.fetch(DASHBOARD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authResult.accessToken}`,
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1'
      },
      body: JSON.stringify({}),
      signal: requestSignal
    })

    if (res.status === 401 || res.status === 403) {
      return result('error', 'Cursor sign-in expired — run cursor-agent and sign in again', {
        usageMetadata: { failureKind: 'stale-token', source }
      })
    }
    if (!res.ok) {
      return result('error', `Cursor usage request failed (HTTP ${res.status})`, {
        usageMetadata: { failureKind: 'server', source }
      })
    }

    let data: unknown
    try {
      data = await res.json()
    } catch {
      return parseFailure(source)
    }
    if (typeof data !== 'object' || data === null) {
      return parseFailure(source)
    }
    return mapDashboardResponse(data as CursorDashboardResponse, source)
  } catch (err) {
    return result('error', err instanceof Error ? err.message : 'Cursor usage request failed', {
      usageMetadata: { failureKind: 'network', source }
    })
  }
}
