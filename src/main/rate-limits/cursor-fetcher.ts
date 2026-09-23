import { net } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import {
  readCursorAuthSession,
  type CursorAuthReadResult,
  type CursorAuthSession
} from './cursor-auth'

const CURSOR_DASHBOARD_ORIGIN = 'https://cursor.com'
const USAGE_SUMMARY_URL = `${CURSOR_DASHBOARD_ORIGIN}/api/usage-summary`
const LEGACY_USAGE_URL = `${CURSOR_DASHBOARD_ORIGIN}/api/usage`
const API_TIMEOUT_MS = 10_000
const MONTHLY_WINDOW_MINUTES = 43_200

type CursorPlanUsage = {
  enabled?: boolean
  used?: number
  limit?: number | null
  remaining?: number | null
}

type CursorUsageSummary = {
  billingCycleStart?: string
  billingCycleEnd?: string
  membershipType?: string
  isUnlimited?: boolean
  individualUsage?: {
    plan?: CursorPlanUsage
    onDemand?: CursorPlanUsage
  }
}

type CursorLegacyBucket = {
  numRequests?: number
  maxRequestUsage?: number | null
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  extra: Partial<ProviderRateLimits> = {}
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

function parseResetDescription(isoString: string | undefined): string | null {
  if (!isoString) {
    return null
  }
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function monthlyWindow(usedPercent: number, billingCycleEnd: string | undefined): RateLimitWindow {
  const resetsAtMs = billingCycleEnd ? Date.parse(billingCycleEnd) : Number.NaN
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowMinutes: MONTHLY_WINDOW_MINUTES,
    resetsAt: Number.isFinite(resetsAtMs) ? resetsAtMs : null,
    resetDescription: parseResetDescription(billingCycleEnd)
  }
}

/**
 * Maps the spend allowance Cursor reports for pro / pro_plus / ultra plans.
 *
 * The percentage is derived from `used / limit` (both in cents) rather than
 * from the sibling `totalPercentUsed`: the raw pair is internally consistent
 * (`used + remaining === limit`) while the percentage fields are rounded for
 * the dashboard's own copy and disagree with it on real accounts.
 */
function mapPlanUsage(summary: CursorUsageSummary): RateLimitWindow | null {
  const plan = summary.individualUsage?.plan
  if (!plan?.enabled) {
    return null
  }
  const used = plan.used
  const limit = plan.limit
  if (typeof used !== 'number' || typeof limit !== 'number' || !Number.isFinite(limit)) {
    return null
  }
  // Why: a zero or negative ceiling cannot produce a percentage; treat it as
  // "no allowance reported" so the caller can fall back instead of dividing.
  if (limit <= 0) {
    return null
  }
  return monthlyWindow((used / limit) * 100, summary.billingCycleEnd)
}

/**
 * Request-quota plans predate spend-based billing and report a per-model
 * ceiling instead of a cents allowance. Kept so those accounts still get a bar.
 */
function mapLegacyRequestQuota(payload: unknown): RateLimitWindow | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const buckets: { name: string; used: number; limit: number }[] = []
  for (const [name, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      continue
    }
    const bucket = value as CursorLegacyBucket
    const limit = bucket.maxRequestUsage
    const used = bucket.numRequests
    if (typeof limit !== 'number' || limit <= 0 || typeof used !== 'number') {
      continue
    }
    buckets.push({ name, used, limit })
  }
  if (buckets.length === 0) {
    return null
  }
  // Why: 'gpt-4' is the premium bucket on legacy plans; otherwise take the
  // largest ceiling, which is the headline quota on every shape seen so far.
  const quota =
    buckets.find((entry) => entry.name === 'gpt-4') ??
    buckets.sort((left, right) => right.limit - left.limit)[0]

  const startOfMonth = (payload as { startOfMonth?: unknown }).startOfMonth
  let resetsAtIso: string | undefined
  if (typeof startOfMonth === 'string') {
    const start = new Date(startOfMonth)
    if (!Number.isNaN(start.getTime())) {
      start.setMonth(start.getMonth() + 1)
      resetsAtIso = start.toISOString()
    }
  }
  return monthlyWindow((quota.used / quota.limit) * 100, resetsAtIso)
}

/**
 * Dashboard routes answer 403 to a bare session cookie — they check the request
 * origin as CSRF defence. Sending the origin the dashboard itself sends is what
 * they expect; without these headers every /api route fails on a valid session.
 */
function cursorRequestHeaders(session: CursorAuthSession): Record<string, string> {
  return {
    Cookie: `WorkosCursorSessionToken=${encodeURIComponent(session.sessionToken)}`,
    Accept: 'application/json',
    Origin: CURSOR_DASHBOARD_ORIGIN,
    Referer: `${CURSOR_DASHBOARD_ORIGIN}/dashboard`
  }
}

type CursorFetchOutcome =
  | { kind: 'data'; data: unknown }
  | { kind: 'result'; result: ProviderRateLimits }

async function fetchDashboardJson(
  url: string,
  session: CursorAuthSession,
  signal?: AbortSignal
): Promise<CursorFetchOutcome> {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS)
  const res = await net.fetch(url, {
    headers: cursorRequestHeaders(session),
    signal: requestSignal
  })
  if (res.status === 401 || res.status === 403) {
    return {
      kind: 'result',
      result: result('error', 'Cursor sign-in expired — run cursor-agent login', {
        usageMetadata: { source: 'web', failureKind: 'stale-token' }
      })
    }
  }
  if (!res.ok) {
    return {
      kind: 'result',
      result: result('error', `Cursor usage request failed (HTTP ${res.status})`, {
        usageMetadata: { source: 'web', failureKind: 'server' }
      })
    }
  }
  return { kind: 'data', data: await res.json() }
}

function usageResult(monthly: RateLimitWindow, summary: CursorUsageSummary): ProviderRateLimits {
  return result('ok', null, {
    monthly,
    planType: typeof summary.membershipType === 'string' ? summary.membershipType : null,
    usageMetadata: { source: 'web' }
  })
}

// Why: Orca never runs cursor-agent login; it only reads the session the CLI
// writes, so an expired token is reported rather than refreshed here.
export async function fetchCursorRateLimits(
  options: { signal?: AbortSignal; authReadResult?: CursorAuthReadResult } = {}
): Promise<ProviderRateLimits> {
  const readResult = options.authReadResult ?? readCursorAuthSession()
  if (readResult.status === 'missing') {
    return result('unavailable', 'Not signed in to Cursor — run cursor-agent login', {
      usageMetadata: { failureKind: 'missing-credentials' }
    })
  }
  if (readResult.status === 'error') {
    return result('error', readResult.error, {
      usageMetadata: { failureKind: 'missing-credentials' }
    })
  }
  const session = readResult.session

  try {
    const outcome = await fetchDashboardJson(USAGE_SUMMARY_URL, session, options.signal)
    if (outcome.kind === 'result') {
      return outcome.result
    }
    const summary =
      typeof outcome.data === 'object' && outcome.data !== null
        ? (outcome.data as CursorUsageSummary)
        : {}

    // Why: an unlimited plan has no ceiling to divide by. Publish the plan and
    // cycle so the roster still lists the account, with no misleading bar.
    if (summary.isUnlimited === true) {
      return result('ok', null, {
        planType: typeof summary.membershipType === 'string' ? summary.membershipType : null,
        usageMetadata: { source: 'web' }
      })
    }

    const planWindow = mapPlanUsage(summary)
    if (planWindow) {
      return usageResult(planWindow, summary)
    }

    // Why: accounts still on request-quota billing report nothing under
    // individualUsage, so fall back to the older per-model endpoint before
    // concluding the account has no visible quota.
    const legacy = await fetchDashboardJson(
      `${LEGACY_USAGE_URL}?user=${encodeURIComponent(session.userId)}`,
      session,
      options.signal
    )
    if (legacy.kind === 'result') {
      return legacy.result
    }
    const legacyWindow = mapLegacyRequestQuota(legacy.data)
    if (legacyWindow) {
      return usageResult(legacyWindow, summary)
    }

    // Why: a 200 with no allowance means the plan exposes no quota (API-key or
    // team-billed accounts). 'unavailable' hides the bar the way Claude does on
    // API-key billing; 'error' would paint a permanent alert for a healthy account.
    return result('unavailable', 'Cursor reported no usage allowance for this account', {
      planType: typeof summary.membershipType === 'string' ? summary.membershipType : null
    })
  } catch (err) {
    return result('error', err instanceof Error ? err.message : 'Cursor usage request failed', {
      usageMetadata: { source: 'web', failureKind: 'network' }
    })
  }
}
