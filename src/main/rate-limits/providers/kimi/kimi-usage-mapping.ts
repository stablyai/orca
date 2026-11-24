import type {
  ProviderRateLimits,
  RateLimitWindow
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'

const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10080
const MONTHLY_WINDOW_MINUTES = 43_200

type KimiUsageDetail = {
  limit?: string | number
  remaining?: string | number
  used?: string | number
  resetTime?: string
  resetAt?: string
}

type KimiUsageWindow = {
  duration?: number
  timeUnit?: string
}

type KimiUsageLimit = {
  window?: KimiUsageWindow
  detail?: KimiUsageDetail
}

type KimiUsageRatio = {
  used_ratio?: string | number
  reset_time?: string
}

type KimiUsageResponse = {
  usage?: KimiUsageDetail
  limits?: KimiUsageLimit[]
  usages?: { limit_month_total?: KimiUsageRatio }
}

function toFiniteNumber(value: string | number | undefined): number | null {
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
  const duration = toFiniteNumber(window?.duration)
  if (duration === null) {
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

function toWindow(
  usedFraction: number,
  windowMinutes: number,
  reset: string | undefined
): RateLimitWindow {
  return {
    usedPercent: Math.min(100, Math.max(0, usedFraction * 100)),
    windowMinutes,
    resetsAt: reset ? new Date(reset).getTime() || null : null,
    resetDescription: parseResetDescription(reset)
  }
}

function mapWindow(
  detail: KimiUsageDetail | undefined,
  windowMinutes: number
): RateLimitWindow | null {
  if (!detail) {
    return null
  }
  const limit = toFiniteNumber(detail.limit)
  let used = toFiniteNumber(detail.used)
  if (used === null) {
    const remaining = toFiniteNumber(detail.remaining)
    if (remaining !== null && limit !== null) {
      used = limit - remaining
    }
  }
  if (limit === null || limit <= 0 || used === null) {
    return null
  }
  return toWindow(used / limit, windowMinutes, detail.resetTime ?? detail.resetAt)
}

function mapRatioWindow(
  entry: KimiUsageRatio | undefined,
  windowMinutes: number
): RateLimitWindow | null {
  const ratio = toFiniteNumber(entry?.used_ratio)
  return ratio === null ? null : toWindow(ratio, windowMinutes, entry?.reset_time)
}

export function mapKimiUsageResponse(data: KimiUsageResponse): ProviderRateLimits {
  // Top-level usage is weekly; limits carries shorter rolling windows, including the 5h session.
  const weekly = mapWindow(data.usage, WEEKLY_WINDOW_MINUTES)
  let session: RateLimitWindow | null = null
  for (const limit of data.limits ?? []) {
    const minutes = windowToMinutes(limit.window) ?? SESSION_WINDOW_MINUTES
    const mapped = mapWindow(limit.detail, minutes)
    if (!mapped) {
      continue
    }
    // Prefer the window closest to a 5h session; otherwise keep the first seen.
    if (
      session === null ||
      Math.abs(minutes - SESSION_WINDOW_MINUTES) <
        Math.abs(session.windowMinutes - SESSION_WINDOW_MINUTES)
    ) {
      session = mapped
    }
  }
  // Current plans report the monthly pool as a 0..1 ratio; limit_month_code is a slice of it.
  const monthly = mapRatioWindow(data.usages?.limit_month_total, MONTHLY_WINDOW_MINUTES)
  return {
    provider: 'kimi',
    session,
    weekly,
    ...(monthly ? { monthly } : {}),
    updatedAt: Date.now(),
    error:
      session || weekly || monthly ? null : 'Kimi usage response did not include quota windows',
    status: session || weekly || monthly ? 'ok' : 'error'
  }
}
