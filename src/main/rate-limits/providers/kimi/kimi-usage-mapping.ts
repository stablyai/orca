import type {
  ProviderRateLimits,
  RateLimitWindow
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'

const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10080
const MONTHLY_WINDOW_MINUTES = 43_200
const MIN_MONTHLY_WINDOW_MINUTES = 28 * 24 * 60

type KimiUsageWindow = {
  duration?: number
  timeUnit?: string
}

type KimiUsageDetail = {
  limit?: string | number
  remaining?: string | number
  used?: string | number
  resetTime?: string
  resetAt?: string
  window?: KimiUsageWindow
}

type KimiUsageLimit = {
  window?: KimiUsageWindow
  detail?: KimiUsageDetail
}

type KimiUsageRatioWindow = {
  used_ratio?: number | string
  usedRatio?: number | string
  reset_time?: string
  resetTime?: string
  resetAt?: string
}

type KimiUsageMap = {
  limit_5h?: KimiUsageRatioWindow
  limit_month_total?: KimiUsageRatioWindow
}

export type KimiUsageResponse = {
  usage?: KimiUsageDetail
  limits?: KimiUsageLimit[]
  usages?: KimiUsageMap
}

function toInt(value: string | number | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function windowToMinutes(window: KimiUsageWindow | undefined): number | null {
  const duration = toInt(window?.duration)
  if (duration === null || duration <= 0) {
    return null
  }
  const unit = (window?.timeUnit ?? '').toUpperCase()
  if (unit.includes('MINUTE')) {
    return duration
  }
  if (unit.includes('HOUR')) {
    return duration * 60
  }
  if (unit.includes('DAY')) {
    return duration * 60 * 24
  }
  if (unit.includes('WEEK')) {
    return duration * WEEKLY_WINDOW_MINUTES
  }
  if (unit.includes('MONTH')) {
    return duration * MONTHLY_WINDOW_MINUTES
  }
  if (unit.includes('SECOND')) {
    return Math.round(duration / 60)
  }
  return duration
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

function mapWindow(
  detail: KimiUsageDetail | undefined,
  windowMinutes: number
): RateLimitWindow | null {
  if (!detail) {
    return null
  }
  const limit = toInt(detail.limit)
  let used = toInt(detail.used)
  if (used === null) {
    const remaining = toInt(detail.remaining)
    if (remaining !== null && limit !== null) {
      used = limit - remaining
    }
  }
  if (limit === null || limit <= 0 || used === null) {
    return null
  }
  const reset = detail.resetTime ?? detail.resetAt
  return {
    usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
    windowMinutes,
    resetsAt: reset ? new Date(reset).getTime() || null : null,
    resetDescription: parseResetDescription(reset)
  }
}

function mapRatioWindow(
  entry: KimiUsageRatioWindow | undefined,
  windowMinutes: number
): RateLimitWindow | null {
  if (!entry) {
    return null
  }
  const ratio = toInt(entry.used_ratio ?? entry.usedRatio)
  if (ratio === null) {
    return null
  }
  const reset = entry.reset_time ?? entry.resetTime ?? entry.resetAt
  return {
    usedPercent: Math.min(100, Math.max(0, ratio * 100)),
    windowMinutes,
    resetsAt: reset ? new Date(reset).getTime() || null : null,
    resetDescription: parseResetDescription(reset)
  }
}

function pickCloserWindow(
  current: RateLimitWindow | null,
  candidate: RateLimitWindow,
  targetMinutes: number
): RateLimitWindow {
  if (
    current === null ||
    Math.abs(candidate.windowMinutes - targetMinutes) <
      Math.abs(current.windowMinutes - targetMinutes)
  ) {
    return candidate
  }
  return current
}

export function mapKimiUsageResponse(data: KimiUsageResponse): ProviderRateLimits {
  let session: RateLimitWindow | null = null
  let weekly: RateLimitWindow | null = null
  let monthly: RateLimitWindow | null = null

  for (const limit of data.limits ?? []) {
    const minutes = windowToMinutes(limit.window) ?? SESSION_WINDOW_MINUTES
    const mapped = mapWindow(limit.detail, minutes)
    if (!mapped) {
      continue
    }
    if (minutes >= MIN_MONTHLY_WINDOW_MINUTES) {
      monthly = pickCloserWindow(monthly, mapped, MONTHLY_WINDOW_MINUTES)
    } else if (minutes >= WEEKLY_WINDOW_MINUTES) {
      weekly = pickCloserWindow(weekly, mapped, WEEKLY_WINDOW_MINUTES)
    } else {
      session = pickCloserWindow(session, mapped, SESSION_WINDOW_MINUTES)
    }
  }

  if (data.usage) {
    const usageMinutes = windowToMinutes(data.usage.window)
    if (usageMinutes !== null) {
      const mapped = mapWindow(data.usage, usageMinutes)
      if (mapped) {
        if (usageMinutes >= MIN_MONTHLY_WINDOW_MINUTES) {
          monthly ??= mapped
        } else if (usageMinutes >= WEEKLY_WINDOW_MINUTES) {
          weekly ??= mapped
        } else {
          session ??= mapped
        }
      }
    } else if (!weekly) {
      // Legacy top-level usage has no window descriptor and represents the 7-day weekly pool.
      weekly = mapWindow(data.usage, WEEKLY_WINDOW_MINUTES)
    }
  }

  // Newer Kimi Code responses may expose 5h and monthly totals under `usages`.
  if (!session && data.usages?.limit_5h) {
    session = mapRatioWindow(data.usages.limit_5h, SESSION_WINDOW_MINUTES)
  }
  if (!monthly && data.usages?.limit_month_total) {
    monthly = mapRatioWindow(data.usages.limit_month_total, MONTHLY_WINDOW_MINUTES)
  }

  const hasWindow = Boolean(session || weekly || monthly)
  return {
    provider: 'kimi',
    session,
    weekly,
    ...(monthly ? { monthly } : {}),
    updatedAt: Date.now(),
    error: hasWindow ? null : 'Kimi usage response did not include quota windows',
    status: hasWindow ? 'ok' : 'error'
  }
}
