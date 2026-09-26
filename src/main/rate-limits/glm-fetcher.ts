import { net } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const API_TIMEOUT_MS = 10_000

const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10080

const ZAI_BASE = 'https://api.z.ai'
const ZHIPU_BASE = 'https://open.bigmodel.cn'

// Why: the quota endpoint is undocumented, so it is read defensively. Window
// identity comes from `unit` only (3 = 5-hour, 6 = weekly); `percentage` is
// provided directly and may exceed 100. Observed limit types: CREDIT_LIMIT
// (2026-08 live) and TOKENS_LIMIT (community reports on token-metered plans).
const QUOTA_LIMIT_TYPES = new Set(['CREDIT_LIMIT', 'TOKENS_LIMIT'])
const UNIT_FIVE_HOUR = 3
const UNIT_WEEKLY = 6

type GlmQuotaLimit = {
  type?: unknown
  unit?: unknown
  percentage?: unknown
  nextResetTime?: unknown
}

type GlmQuotaResponse = {
  success?: unknown
  data?: { limits?: unknown; level?: unknown }
}

function isQuotaLimitType(limit: GlmQuotaLimit): boolean {
  return typeof limit.type === 'string' && QUOTA_LIMIT_TYPES.has(limit.type)
}

function toRateLimitWindow(limit: GlmQuotaLimit, windowMinutes: number): RateLimitWindow | null {
  if (typeof limit.percentage !== 'number' || !Number.isFinite(limit.percentage)) {
    return null
  }
  const resetsAt =
    typeof limit.nextResetTime === 'number' && Number.isFinite(limit.nextResetTime)
      ? limit.nextResetTime
      : null
  return {
    usedPercent: Math.min(100, Math.max(0, limit.percentage)),
    windowMinutes,
    resetsAt,
    resetDescription: resetsAt ? formatResetTime(resetsAt) : null
  }
}

function formatResetTime(ts: number): string | null {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function mapResponse(data: GlmQuotaResponse): ProviderRateLimits {
  const limits = Array.isArray(data?.data?.limits) ? (data.data.limits as GlmQuotaLimit[]) : []
  let session: RateLimitWindow | null = null
  let weekly: RateLimitWindow | null = null

  for (const limit of limits) {
    if (typeof limit !== 'object' || limit === null || !isQuotaLimitType(limit)) {
      continue
    }
    if (limit.unit === UNIT_FIVE_HOUR) {
      session = toRateLimitWindow(limit, SESSION_WINDOW_MINUTES)
    } else if (limit.unit === UNIT_WEEKLY) {
      weekly = toRateLimitWindow(limit, WEEKLY_WINDOW_MINUTES)
    }
  }

  const planLevel =
    typeof data.data?.level === 'string' && data.data.level.length > 0 ? data.data.level : null

  return {
    provider: 'glm',
    session,
    weekly,
    ...(planLevel ? { planType: planLevel } : {}),
    updatedAt: Date.now(),
    error: session || weekly ? null : 'GLM usage response did not include quota windows',
    status: session || weekly ? 'ok' : 'error'
  }
}

function errorResult(status: ProviderRateLimits['status'], error: string): ProviderRateLimits {
  return {
    provider: 'glm',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status
  }
}

export async function fetchGlmRateLimits(config: {
  platform: 'zai' | 'zhipu'
  apiKey: string
  signal?: AbortSignal
}): Promise<ProviderRateLimits> {
  if (!config.apiKey) {
    return errorResult('unavailable', 'No GLM API key configured')
  }

  const base = config.platform === 'zhipu' ? ZHIPU_BASE : ZAI_BASE
  const url = `${base}/api/monitor/usage/quota/limit`
  const requestSignal = config.signal
    ? AbortSignal.any([config.signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS)

  try {
    const res = await net.fetch(url, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json'
      },
      signal: requestSignal
    })
    if (res.status === 401 || res.status === 403) {
      return errorResult('error', `GLM usage request unauthorized (HTTP ${res.status})`)
    }
    if (!res.ok) {
      return errorResult('error', `GLM usage request failed (HTTP ${res.status})`)
    }
    const data: unknown = await res.json()
    return mapResponse(typeof data === 'object' && data !== null ? data : {})
  } catch (err) {
    return errorResult('error', err instanceof Error ? err.message : 'GLM usage request failed')
  }
}
