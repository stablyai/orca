import { net } from 'electron'
import {
  CURSOR_MODELS_BUCKET_NAME,
  CURSOR_OTHER_MODELS_BUCKET_NAME
} from '../../shared/cursor-usage-buckets'
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

/** Builds a Cursor {@link ProviderRateLimits} stub with shared defaults. */
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

/** Coerces a DashboardService numeric field to a finite number, or null. */
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

/** Clamps a usage percent into the inclusive 0–100 range. */
function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

/** Billing-cycle length in minutes; falls back to a 30-day window. */
function computeWindowMinutes(startMs: number | null, endMs: number | null): number {
  if (startMs === null || endMs === null) {
    return MONTHLY_WINDOW_MINUTES
  }
  const diffMinutes = (endMs - startMs) / 60_000
  return diffMinutes > 0 ? diffMinutes : MONTHLY_WINDOW_MINUTES
}

/** Human-readable reset label from a billing-cycle end epoch ms. */
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

/** Optional plan name from DashboardService (`planType` or `plan`). */
function extractPlanType(data: CursorDashboardResponse): string | undefined {
  const candidate = data.planType ?? data.plan
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

/** Maps auto/API percent fields into named Cursor usage buckets. */
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
      name: CURSOR_MODELS_BUCKET_NAME,
      usedPercent: clampPercent(autoPercent),
      windowMinutes,
      resetsAt,
      resetDescription
    })
  }
  const apiPercent = toFiniteNumber(usage.apiPercentUsed)
  if (apiPercent !== null) {
    buckets.push({
      name: CURSOR_OTHER_MODELS_BUCKET_NAME,
      usedPercent: clampPercent(apiPercent),
      windowMinutes,
      resetsAt,
      resetDescription
    })
  }
  return buckets.length > 0 ? buckets : undefined
}

/**
 * Maps CLI/IDE auth provenance onto UsageRateLimitSource.
 * Why: UsageRateLimitSource has no `ide` value — IDE sessions map to `web`.
 */
function toUsageMetadataSource(authSource: 'cli' | 'ide'): 'cli' | 'web' {
  return authSource === 'ide' ? 'web' : 'cli'
}

/** Standard parse-failure Cursor rate-limit result. */
function parseFailure(source: 'cli' | 'web'): ProviderRateLimits {
  return result('error', 'Cursor usage response could not be parsed', {
    usageMetadata: { failureKind: 'parse', source }
  })
}

/** Maps DashboardService JSON into Orca's Cursor {@link ProviderRateLimits}. */
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

/** Fetches Cursor monthly plan usage via DashboardService using a local session token. */
export async function fetchCursorRateLimits(
  options: { signal?: AbortSignal; authReadResult?: CursorAuthReadResult } = {}
): Promise<ProviderRateLimits> {
  const authResult =
    options.authReadResult ?? (await readCursorAuthSession({ signal: options.signal }))
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
