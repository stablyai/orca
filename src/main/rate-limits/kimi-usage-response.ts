import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10080

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

type KimiUsageResponse = {
  usage?: KimiUsageDetail
  limits?: KimiUsageLimit[]
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

export function mapKimiUsageResponse(data: KimiUsageResponse): ProviderRateLimits {
  // Why: the top-level `usage` block is the weekly quota; the windowed entries
  // in `limits` carry shorter rolling windows — the 5h one is the session view.
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
  return {
    provider: 'kimi',
    session,
    weekly,
    updatedAt: Date.now(),
    error: session || weekly ? null : 'Kimi usage response did not include quota windows',
    status: session || weekly ? 'ok' : 'error'
  }
}
