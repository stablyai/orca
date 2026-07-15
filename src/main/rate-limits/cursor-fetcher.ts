import { net } from 'electron'
import type { ProviderRateLimits, RateLimitBucket } from '../../shared/rate-limit-types'
import {
  readCursorAuthSession,
  type CursorAuthReadResult,
  type CursorAuthSession
} from './cursor-auth'

const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'
const API_TIMEOUT_MS = 10_000
const DEFAULT_CYCLE_MINUTES = 43_200 // 30d

// Why: short labels keep three Cursor meters readable in the compact status bar
// (mirrors Gemini's Flash/Pro bucket names).
export const CURSOR_BUCKET_INCLUDED = 'Included'
export const CURSOR_BUCKET_AUTO = 'Auto'
export const CURSOR_BUCKET_ON_DEMAND = 'On-demand'

type CursorPlanUsage = {
  totalSpend?: number
  includedSpend?: number
  bonusSpend?: number
  limit?: number
  autoPercentUsed?: number
  apiPercentUsed?: number
  totalPercentUsed?: number
}

type CursorSpendLimitUsage = {
  individualLimit?: number
  individualUsed?: number
  individualRemaining?: number
  limitType?: string
}

type CursorPeriodUsageResponse = {
  billingCycleStart?: string | number
  billingCycleEnd?: string | number
  planUsage?: CursorPlanUsage
  spendLimitUsage?: CursorSpendLimitUsage
  displayMessage?: string
  autoModelSelectedDisplayMessage?: string
  namedModelSelectedDisplayMessage?: string
  enabled?: boolean
}

function result(status: ProviderRateLimits['status'], error: string | null): ProviderRateLimits {
  return {
    provider: 'cursor',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status
  }
}

function parseMs(value: string | number | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) {
      return asNumber
    }
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseResetDescription(resetsAt: number | null): string | null {
  if (resetsAt === null) {
    return null
  }
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function parsePercentFromDisplayMessage(message: string | undefined): number | null {
  if (!message) {
    return null
  }
  const match = message.match(/(\d+(?:\.\d+)?)\s*%/)
  if (!match?.[1]) {
    return null
  }
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function resolveIncludedPercent(data: CursorPeriodUsageResponse): number | null {
  // Why: Cursor's displayMessage ("67% of your included usage") does not match
  // the Included total meter in Cursor's own UI. That meter tracks
  // totalPercentUsed / "included total usage" (~29%).
  const plan = data.planUsage
  if (plan && typeof plan.totalPercentUsed === 'number' && Number.isFinite(plan.totalPercentUsed)) {
    return clampPercent(plan.totalPercentUsed)
  }
  const fromTotalMessage = parsePercentFromDisplayMessage(data.autoModelSelectedDisplayMessage)
  if (fromTotalMessage !== null) {
    return clampPercent(fromTotalMessage)
  }
  if (
    plan &&
    typeof plan.includedSpend === 'number' &&
    typeof plan.limit === 'number' &&
    plan.limit > 0
  ) {
    return clampPercent((plan.includedSpend / plan.limit) * 100)
  }
  // Why: displayMessage ("67% of your included usage") disagrees with Cursor's
  // Included total meter — omit rather than show the wrong number.
  return null
}

function resolveAutoPercent(data: CursorPeriodUsageResponse): number | null {
  const plan = data.planUsage
  if (plan && typeof plan.autoPercentUsed === 'number' && Number.isFinite(plan.autoPercentUsed)) {
    return clampPercent(plan.autoPercentUsed)
  }
  // Why: autoModelSelectedDisplayMessage describes total included usage when
  // Auto is selected — not the Auto+Composer pool — so it must not be a fallback.
  return null
}

function resolveOnDemandPercent(data: CursorPeriodUsageResponse): number | null {
  const spend = data.spendLimitUsage
  if (!spend) {
    return null
  }
  // Why: on-demand is the pay-as-you-go spend cap after included pools, not
  // apiPercentUsed (that field is the included API pool).
  if (
    typeof spend.individualUsed === 'number' &&
    typeof spend.individualLimit === 'number' &&
    spend.individualLimit > 0
  ) {
    return clampPercent((spend.individualUsed / spend.individualLimit) * 100)
  }
  if (
    typeof spend.individualLimit === 'number' &&
    spend.individualLimit > 0 &&
    typeof spend.individualRemaining === 'number'
  ) {
    return clampPercent(
      ((spend.individualLimit - spend.individualRemaining) / spend.individualLimit) * 100
    )
  }
  return null
}

function resolveWindowMinutes(startMs: number | null, endMs: number | null): number {
  if (startMs !== null && endMs !== null && endMs > startMs) {
    const minutes = Math.round((endMs - startMs) / 60_000)
    if (minutes > 0) {
      return minutes
    }
  }
  return DEFAULT_CYCLE_MINUTES
}

function makeBucket(
  name: string,
  usedPercent: number,
  windowMinutes: number,
  resetsAt: number | null
): RateLimitBucket {
  return {
    name,
    usedPercent,
    windowMinutes,
    resetsAt,
    resetDescription: parseResetDescription(resetsAt)
  }
}

function mapUsageBuckets(data: CursorPeriodUsageResponse): RateLimitBucket[] {
  const startMs = parseMs(data.billingCycleStart)
  const endMs = parseMs(data.billingCycleEnd)
  const windowMinutes = resolveWindowMinutes(startMs, endMs)
  const buckets: RateLimitBucket[] = []

  const included = resolveIncludedPercent(data)
  if (included !== null) {
    buckets.push(makeBucket(CURSOR_BUCKET_INCLUDED, included, windowMinutes, endMs))
  }

  const auto = resolveAutoPercent(data)
  if (auto !== null) {
    buckets.push(makeBucket(CURSOR_BUCKET_AUTO, auto, windowMinutes, endMs))
  }

  const onDemand = resolveOnDemandPercent(data)
  if (onDemand !== null) {
    buckets.push(makeBucket(CURSOR_BUCKET_ON_DEMAND, onDemand, windowMinutes, endMs))
  }

  return buckets
}

function mapUsageResponse(
  data: CursorPeriodUsageResponse,
  session: CursorAuthSession
): ProviderRateLimits {
  const buckets = mapUsageBuckets(data)
  const plan = session.membershipType?.trim()
  const authLabel = session.email?.trim() || 'Cursor account'
  const provenance = plan ? `${authLabel} (${plan})` : authLabel
  return {
    provider: 'cursor',
    session: null,
    weekly: null,
    buckets,
    updatedAt: Date.now(),
    error: buckets.length > 0 ? null : 'Cursor usage response did not include usage meters',
    status: buckets.length > 0 ? 'ok' : 'unavailable',
    usageMetadata: {
      source: 'oauth',
      authProvenance: provenance
    }
  }
}

// Why: Orca never runs Cursor login; it only reads the IDE session Cursor updates.
export async function fetchCursorRateLimits(
  options: {
    signal?: AbortSignal
    authReadResult?: CursorAuthReadResult
  } = {}
): Promise<ProviderRateLimits> {
  const readResult = options.authReadResult ?? readCursorAuthSession()
  if (readResult.status === 'missing') {
    return result('unavailable', 'Not signed in to Cursor')
  }
  if (readResult.status === 'error') {
    return result('error', readResult.error)
  }
  const session = readResult.session

  try {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(API_TIMEOUT_MS)])
      : AbortSignal.timeout(API_TIMEOUT_MS)
    const res = await net.fetch(USAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1'
      },
      body: '{}',
      signal
    })
    if (res.status === 401 || res.status === 403) {
      return result('error', 'Cursor session expired — sign in again in Cursor')
    }
    if (!res.ok) {
      return result('error', `Cursor usage request failed (HTTP ${res.status})`)
    }
    const data: unknown = await res.json()
    return mapUsageResponse(
      typeof data === 'object' && data !== null ? (data as CursorPeriodUsageResponse) : {},
      session
    )
  } catch (err) {
    return result('error', err instanceof Error ? err.message : 'Cursor usage request failed')
  }
}
