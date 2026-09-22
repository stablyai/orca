import { net } from 'electron'
import type {
  FactoryApiKeySource,
  ProviderRateLimits,
  RateLimitWindow,
  UsageRateLimitMetadata
} from '../../shared/rate-limit-types'
import { resolveFactoryApiKey, type FactoryApiKeyReadResult } from './factory-auth'
import {
  API_TIMEOUT_MS,
  FACTORY_API_BASE,
  fetchFactoryLegacyWeekly,
  makeFactoryRequestHeaders,
  WEEKLY_WINDOW_MINUTES
} from './factory-legacy-usage'

const BILLING_LIMITS_URL = `${FACTORY_API_BASE}/api/billing/limits`
const AUTH_ME_URL = `${FACTORY_API_BASE}/api/app/auth/me`
const FIVE_HOUR_MINUTES = 300
const MONTHLY_WINDOW_MINUTES = 43_200

type FactoryBillingWindow = {
  usedPercent?: unknown
  windowEnd?: unknown
  secondsRemaining?: unknown
}

type FactoryLimitPool = {
  fiveHour?: FactoryBillingWindow
  weekly?: FactoryBillingWindow
  monthly?: FactoryBillingWindow
}

type FactoryBillingLimitsResponse = {
  usesTokenRateLimitsBilling?: unknown
  limits?: {
    standard?: FactoryLimitPool
    core?: FactoryLimitPool
  }
}

type FactoryAuthMeResponse = {
  user?: { email?: unknown }
  userProfile?: { email?: unknown }
  organization?: {
    planName?: unknown
    subscription?: { factoryTier?: unknown }
  }
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  usageMetadata?: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    provider: 'factory',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...(usageMetadata ? { usageMetadata } : {})
  }
}

function failureKindForHttp(status: number): UsageRateLimitMetadata['failureKind'] {
  return status >= 500 ? 'server' : 'network'
}

function usageSourceFor(source: FactoryApiKeySource): UsageRateLimitMetadata['source'] {
  return source === 'orca' ? 'web' : 'cli'
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

// Why: copy Grok's local-time reset formatting so every provider's "Resets" text matches.
function formatResetDescription(date: Date): string {
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function resolveResetsAt(window: FactoryBillingWindow): number | null {
  const { windowEnd, secondsRemaining } = window
  if (typeof windowEnd === 'string' && windowEnd.trim().length > 0) {
    const parsed = Date.parse(windowEnd)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  if (typeof windowEnd === 'number' && Number.isFinite(windowEnd)) {
    // Why: epoch-ms values exceed 1e12 well before 2286; epoch-seconds don't until 33658.
    return windowEnd >= 1e12 ? windowEnd : windowEnd * 1000
  }
  if (
    typeof secondsRemaining === 'number' &&
    Number.isFinite(secondsRemaining) &&
    secondsRemaining > 0
  ) {
    return Date.now() + secondsRemaining * 1000
  }
  return null
}

function mapWindow(
  window: FactoryBillingWindow | undefined,
  windowMinutes: number
): RateLimitWindow | null {
  if (!window) {
    return null
  }
  const usedPercent = typeof window.usedPercent === 'number' ? window.usedPercent : Number.NaN
  if (!Number.isFinite(usedPercent)) {
    return null
  }
  const resetsAt = resolveResetsAt(window)
  return {
    usedPercent: clampPercent(usedPercent),
    windowMinutes,
    resetsAt,
    resetDescription: resetsAt !== null ? formatResetDescription(new Date(resetsAt)) : null
  }
}

function hasAnyWindow(pool: FactoryLimitPool | undefined): boolean {
  return Boolean(
    pool &&
    (mapWindow(pool.fiveHour, FIVE_HOUR_MINUTES) ||
      mapWindow(pool.weekly, WEEKLY_WINDOW_MINUTES) ||
      mapWindow(pool.monthly, MONTHLY_WINDOW_MINUTES))
  )
}

function mapPoolToWindows(pool: FactoryLimitPool): {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  monthly: RateLimitWindow | null
} {
  return {
    session: mapWindow(pool.fiveHour, FIVE_HOUR_MINUTES),
    weekly: mapWindow(pool.weekly, WEEKLY_WINDOW_MINUTES),
    monthly: mapWindow(pool.monthly, MONTHLY_WINDOW_MINUTES)
  }
}

async function fetchAuthMeProvenance(apiKey: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
      : AbortSignal.timeout(API_TIMEOUT_MS)
    const res = await net.fetch(AUTH_ME_URL, {
      headers: makeFactoryRequestHeaders(apiKey),
      signal: requestSignal
    })
    if (!res.ok) {
      return null
    }
    const data: unknown = await res.json()
    if (typeof data !== 'object' || data === null) {
      return null
    }
    const body = data as FactoryAuthMeResponse
    const email =
      (typeof body.user?.email === 'string' && body.user.email.trim()) ||
      (typeof body.userProfile?.email === 'string' && body.userProfile.email.trim()) ||
      null
    const plan =
      (typeof body.organization?.planName === 'string' && body.organization.planName.trim()) ||
      (typeof body.organization?.subscription?.factoryTier === 'string' &&
        body.organization.subscription.factoryTier.trim()) ||
      null
    if (email && plan) {
      return `${email} (${plan})`
    }
    return email || plan
  } catch {
    // Why: auth-me is cosmetic; a failure must never fail the usage result.
    return null
  }
}

export async function fetchFactoryRateLimits(
  options: {
    signal?: AbortSignal
    apiKeyReadResult?: FactoryApiKeyReadResult
  } = {}
): Promise<ProviderRateLimits> {
  const readResult = options.apiKeyReadResult ?? resolveFactoryApiKey()
  if (readResult.status === 'missing') {
    return result('unavailable', 'Factory API key not configured', {
      failureKind: 'missing-credentials',
      source: 'cli'
    })
  }
  if (readResult.status === 'error') {
    return result('error', readResult.error, { failureKind: 'unknown', source: 'cli' })
  }
  const apiKey = readResult.apiKey
  try {
    const requestSignal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(API_TIMEOUT_MS)])
      : AbortSignal.timeout(API_TIMEOUT_MS)
    const res = await net.fetch(BILLING_LIMITS_URL, {
      headers: makeFactoryRequestHeaders(apiKey),
      signal: requestSignal
    })
    if (res.status === 401 || res.status === 403) {
      return result('error', `Factory usage request unauthorized (HTTP ${res.status})`, {
        failureKind: 'stale-token',
        source: usageSourceFor(readResult.source)
      })
    }
    if (!res.ok) {
      return result('error', `Factory usage request failed (HTTP ${res.status})`, {
        failureKind: failureKindForHttp(res.status),
        source: usageSourceFor(readResult.source)
      })
    }
    const data: unknown = await res.json()
    if (typeof data !== 'object' || data === null) {
      return result('error', 'Factory usage returned no quota windows', {
        failureKind: 'usage-unavailable',
        source: usageSourceFor(readResult.source)
      })
    }
    const body = data as FactoryBillingLimitsResponse
    const standard = body.limits?.standard
    const core = body.limits?.core
    // Why: standard is the primary pool; core is only surfaced when standard has no mappable windows.
    const pool = hasAnyWindow(standard) ? standard : hasAnyWindow(core) ? core : null
    if (!pool) {
      // Why: some plans report only the legacy subscription usage view; keep a weekly bar from it.
      const legacy = await fetchFactoryLegacyWeekly(apiKey, options.signal)
      if (legacy.kind === 'weekly') {
        return {
          provider: 'factory',
          session: null,
          weekly: legacy.weekly,
          updatedAt: Date.now(),
          error: null,
          status: 'ok',
          usageMetadata: { source: usageSourceFor(readResult.source) }
        }
      }
      return result('error', 'Factory usage returned no quota windows', {
        failureKind: 'usage-unavailable',
        source: usageSourceFor(readResult.source)
      })
    }
    const windows = mapPoolToWindows(pool)
    const authProvenance = await fetchAuthMeProvenance(apiKey, options.signal)
    return {
      provider: 'factory',
      session: windows.session,
      weekly: windows.weekly,
      ...(windows.monthly ? { monthly: windows.monthly } : {}),
      updatedAt: Date.now(),
      error: null,
      status: 'ok',
      usageMetadata: {
        source: usageSourceFor(readResult.source),
        ...(authProvenance ? { authProvenance } : {})
      }
    }
  } catch (err) {
    return result('error', err instanceof Error ? err.message : 'Factory usage request failed', {
      failureKind: 'network',
      source: usageSourceFor(readResult.source)
    })
  }
}
