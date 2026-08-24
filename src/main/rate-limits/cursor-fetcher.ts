import { net } from 'electron'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow,
  UsageRateLimitMetadata
} from '../../shared/rate-limit-types'
import {
  buildCursorCookieHeader,
  isCursorAccessTokenFresh,
  readCursorAuthSession,
  type CursorAuthReadResult,
  type CursorAuthSession
} from './cursor-auth'

const CURSOR_BASE_URL = 'https://cursor.com'
const API_TIMEOUT_MS = 15_000
const MONTHLY_WINDOW_MINUTES = 43_200

type CursorPlanUsage = {
  used?: number
  limit?: number
  autoPercentUsed?: number
  apiPercentUsed?: number
  totalPercentUsed?: number
}

type CursorUsageSummary = {
  billingCycleEnd?: string
  membershipType?: string
  individualUsage?: {
    plan?: CursorPlanUsage
  }
}

type CursorUserInfo = {
  email?: string
  name?: string
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  usageMetadata?: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    provider: 'cursor',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...(usageMetadata ? { usageMetadata } : {})
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
    : date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function percentFromCents(used?: number, limit?: number): number | null {
  if (
    typeof used !== 'number' ||
    typeof limit !== 'number' ||
    !Number.isFinite(used) ||
    !Number.isFinite(limit) ||
    limit <= 0
  ) {
    return null
  }
  return clampPercent((used / limit) * 100)
}

function normalizePercent(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  return clampPercent(value)
}

function makeWindow(usedPercent: number, resetsAtIso: string | undefined): RateLimitWindow {
  const resetsAt = resetsAtIso ? Date.parse(resetsAtIso) : null
  return {
    usedPercent,
    windowMinutes: MONTHLY_WINDOW_MINUTES,
    resetsAt: resetsAt !== null && Number.isFinite(resetsAt) ? resetsAt : null,
    resetDescription: parseResetDescription(resetsAtIso)
  }
}

function resolvePlanPercent(summary: CursorUsageSummary): number {
  const plan = summary.individualUsage?.plan
  const totalPercent = normalizePercent(plan?.totalPercentUsed)
  if (totalPercent !== null) {
    return totalPercent
  }
  const autoPercent = normalizePercent(plan?.autoPercentUsed)
  const apiPercent = normalizePercent(plan?.apiPercentUsed)
  if (autoPercent !== null && apiPercent !== null) {
    return clampPercent((autoPercent + apiPercent) / 2)
  }
  if (apiPercent !== null) {
    return apiPercent
  }
  if (autoPercent !== null) {
    return autoPercent
  }
  return percentFromCents(plan?.used, plan?.limit) ?? 0
}

function mapUsageSummary(
  summary: CursorUsageSummary,
  userInfo: CursorUserInfo | null,
  session: CursorAuthSession
): ProviderRateLimits {
  const membership = summary.membershipType?.trim()
  const authLabel =
    session.email?.trim() || userInfo?.email?.trim() || userInfo?.name?.trim() || 'Cursor account'
  const provenance = membership ? `${authLabel} (${membership})` : authLabel
  const plan = summary.individualUsage?.plan
  const autoPercent = normalizePercent(plan?.autoPercentUsed)
  const apiPercent = normalizePercent(plan?.apiPercentUsed)
  const buckets: RateLimitBucket[] = []
  if (autoPercent !== null) {
    buckets.push({
      name: 'Auto',
      ...makeWindow(autoPercent, summary.billingCycleEnd)
    })
  }
  if (apiPercent !== null) {
    buckets.push({
      name: 'API',
      ...makeWindow(apiPercent, summary.billingCycleEnd)
    })
  }

  return {
    provider: 'cursor',
    session: null,
    weekly: null,
    monthly: makeWindow(resolvePlanPercent(summary), summary.billingCycleEnd),
    ...(buckets.length > 0 ? { buckets } : {}),
    planType: membership ?? null,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: {
      source: 'web',
      authProvenance: provenance
    }
  }
}

async function fetchJson<T>(
  path: string,
  cookieHeader: string,
  signal?: AbortSignal
): Promise<{ ok: true; data: T } | { ok: false; status: number; body: string }> {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS)
  const res = await net.fetch(`${CURSOR_BASE_URL}${path}`, {
    headers: {
      Accept: 'application/json',
      Cookie: cookieHeader
    },
    signal: requestSignal
  })
  const body = await res.text()
  if (!res.ok) {
    return { ok: false, status: res.status, body }
  }
  try {
    return { ok: true, data: JSON.parse(body) as T }
  } catch {
    return { ok: false, status: res.status, body }
  }
}

function unavailableFromAuth(readResult: CursorAuthReadResult): ProviderRateLimits {
  if (readResult.status === 'missing') {
    return result('unavailable', null, {
      source: 'web',
      failureKind: 'missing-credentials'
    })
  }
  return result('error', readResult.error, { source: 'web' })
}

export async function fetchCursorRateLimits(
  options: { signal?: AbortSignal; authReadResult?: CursorAuthReadResult } = {}
): Promise<ProviderRateLimits> {
  const readResult = options.authReadResult ?? readCursorAuthSession()
  if (readResult.status !== 'ok') {
    return unavailableFromAuth(readResult)
  }
  if (!isCursorAccessTokenFresh(readResult.session)) {
    return result(
      'unavailable',
      'Cursor sign-in expired — sign in to Cursor on the computer running Orca',
      { source: 'web', failureKind: 'stale-token' }
    )
  }
  return fetchCursorRateLimitsForSession(readResult.session, options.signal)
}

export async function fetchCursorRateLimitsForSession(
  session: CursorAuthSession,
  signal?: AbortSignal
): Promise<ProviderRateLimits> {
  const cookieHeader = buildCursorCookieHeader(session)
  const summaryResponse = await fetchJson<CursorUsageSummary>(
    '/api/usage-summary',
    cookieHeader,
    signal
  )
  if (!summaryResponse.ok) {
    if (summaryResponse.status === 401 || summaryResponse.status === 403) {
      return result('unavailable', 'Sign in to Cursor to view usage', {
        source: 'web',
        failureKind: 'stale-token'
      })
    }
    return result('error', `Cursor usage fetch failed (${summaryResponse.status})`, {
      source: 'web',
      failureKind: 'network'
    })
  }

  const userResponse = await fetchJson<CursorUserInfo>('/api/auth/me', cookieHeader, signal)
  const userInfo = userResponse.ok ? userResponse.data : null
  return mapUsageSummary(summaryResponse.data, userInfo, session)
}
