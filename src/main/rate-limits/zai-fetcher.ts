import { net } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit'
export const ZAI_ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic'
const API_TIMEOUT_MS = 10_000
const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10080
const MONTHLY_WINDOW_MINUTES = 43200

const ZAI_NO_API_KEY_ERROR = 'No Z.AI API key configured'
const ZAI_UNAUTHORIZED_ERROR = 'Z.AI usage request unauthorized. Check your API key.'
export function mapZaiQuotaResponse(data: unknown): ProviderRateLimits {
  const limits = readQuotaLimits(data)
  let session: RateLimitWindow | null = null
  let weekly: RateLimitWindow | null = null
  let monthly: RateLimitWindow | null = null

  for (const limit of limits) {
    const mapped = mapQuotaLimit(limit)
    if (!mapped) {
      continue
    }
    if (limit.type === 'TOKENS_LIMIT' && limit.unit === 3) {
      session = mapped
    } else if (limit.type === 'TOKENS_LIMIT' && limit.unit === 6) {
      weekly = mapped
    } else if (limit.type === 'TIME_LIMIT' && limit.unit === 5) {
      monthly = mapped
    }
  }

  const hasWindow = session !== null || weekly !== null || monthly !== null
  return {
    provider: 'zai',
    session,
    weekly,
    monthly,
    updatedAt: Date.now(),
    error: hasWindow ? null : 'Z.AI usage response did not include quota windows',
    status: hasWindow ? 'ok' : 'error'
  }
}

export async function fetchZaiRateLimits(apiKey: string | null): Promise<ProviderRateLimits> {
  if (apiKey === null) {
    return result('unavailable', ZAI_NO_API_KEY_ERROR)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    const res = await net.fetch(ZAI_QUOTA_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      },
      signal: controller.signal
    })
    if (res.status === 401 || res.status === 403) {
      return result('error', ZAI_UNAUTHORIZED_ERROR)
    }
    if (!res.ok) {
      return result('error', `Z.AI usage request failed (HTTP ${res.status})`)
    }
    return mapZaiQuotaResponse(await res.json())
  } catch (error) {
    return result('error', error instanceof Error ? error.message : 'Z.AI usage request failed')
  } finally {
    clearTimeout(timeout)
  }
}

type ZaiQuotaLimit = {
  type: string
  unit: number
  percentage: number
  nextResetTime: number | null
}

function readQuotaLimits(data: unknown): ZaiQuotaLimit[] {
  if (data === null || typeof data !== 'object') {
    return []
  }
  const payload = 'data' in data ? data.data : null
  if (payload === null || typeof payload !== 'object' || !('limits' in payload)) {
    return []
  }
  const limits = payload.limits
  if (!Array.isArray(limits)) {
    return []
  }

  const parsed: ZaiQuotaLimit[] = []
  for (const limit of limits) {
    if (limit === null || typeof limit !== 'object') {
      continue
    }
    const type = 'type' in limit ? limit.type : null
    const unit = 'unit' in limit ? limit.unit : null
    const percentage = 'percentage' in limit ? limit.percentage : null
    const nextResetTime = 'nextResetTime' in limit ? limit.nextResetTime : null
    if (typeof type !== 'string' || typeof unit !== 'number' || typeof percentage !== 'number') {
      continue
    }
    parsed.push({
      type,
      unit,
      percentage,
      nextResetTime:
        typeof nextResetTime === 'number' && Number.isFinite(nextResetTime) ? nextResetTime : null
    })
  }
  return parsed
}

function mapQuotaLimit(limit: ZaiQuotaLimit): RateLimitWindow | null {
  let windowMinutes: number | null = null
  if (limit.type === 'TOKENS_LIMIT' && limit.unit === 3) {
    windowMinutes = SESSION_WINDOW_MINUTES
  } else if (limit.type === 'TOKENS_LIMIT' && limit.unit === 6) {
    windowMinutes = WEEKLY_WINDOW_MINUTES
  } else if (limit.type === 'TIME_LIMIT' && limit.unit === 5) {
    windowMinutes = MONTHLY_WINDOW_MINUTES
  }
  if (windowMinutes === null || !Number.isFinite(limit.percentage)) {
    return null
  }

  return {
    usedPercent: Math.min(100, Math.max(0, limit.percentage)),
    windowMinutes,
    resetsAt: limit.nextResetTime,
    resetDescription: resetDescriptionFromMs(limit.nextResetTime)
  }
}

function resetDescriptionFromMs(timestamp: number | null): string | null {
  if (timestamp === null) {
    return null
  }
  const date = new Date(timestamp)
  if (isNaN(date.getTime())) {
    return null
  }
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function result(status: ProviderRateLimits['status'], error: string | null): ProviderRateLimits {
  return {
    provider: 'zai',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status
  }
}
