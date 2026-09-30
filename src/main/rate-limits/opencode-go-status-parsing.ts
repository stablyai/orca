import type { RateLimitWindow } from '../../shared/rate-limit-types'

const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10_080
const MONTHLY_WINDOW_MINUTES = 43_200
const MAX_STATUS_PAYLOAD_CHARS = 1_000_000

export type OpenCodeGoUsageWindows = {
  session: RateLimitWindow
  weekly: RateLimitWindow
  monthly: RateLimitWindow | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMicroCents(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function parseResetsAt(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }
  const resetsAt = Date.parse(value)
  return Number.isFinite(resetsAt) ? resetsAt : null
}

function meterToWindow(meter: unknown, windowMinutes: number): RateLimitWindow | null {
  if (!isRecord(meter)) {
    return null
  }
  const used = parseMicroCents(meter.usedMicroCents)
  const limit = parseMicroCents(meter.limitMicroCents)
  if (used === null || limit === null || limit <= 0) {
    return null
  }
  return {
    usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
    windowMinutes,
    resetsAt: parseResetsAt(meter.resetsAt),
    resetDescription: null
  }
}

// `GET /zen/go/v1/usage` reports each window as
// `{ status: "ok" | "rate-limited", percent: 0-100, resetsAt: <ISO> }`
// (console `routes/zen/go/v1/usage.ts` + `Subscription.analyze*Usage`).
function percentMeterToWindow(meter: unknown, windowMinutes: number): RateLimitWindow | null {
  if (!isRecord(meter) || typeof meter.percent !== 'number' || !Number.isFinite(meter.percent)) {
    return null
  }
  return {
    usedPercent: Math.min(100, Math.max(0, meter.percent)),
    windowMinutes,
    resetsAt: parseResetsAt(meter.resetsAt),
    resetDescription: null
  }
}

/**
 * Parse the OpenCode Go usage API body into Orca's usage windows.
 * @param text - Raw response body from `GET /zen/go/v1/usage`.
 * @returns The mapped windows, or null when the body is not a usage payload.
 */
export function parseOpenCodeGoUsageApiPayload(text: string): OpenCodeGoUsageWindows | null {
  if (!text || text.length > MAX_STATUS_PAYLOAD_CHARS) {
    return null
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(payload) || !isRecord(payload.usage)) {
    return null
  }
  const session = percentMeterToWindow(payload.usage.rolling, SESSION_WINDOW_MINUTES)
  const weekly = percentMeterToWindow(payload.usage.weekly, WEEKLY_WINDOW_MINUTES)
  if (!session || !weekly) {
    return null
  }
  return {
    session,
    weekly,
    monthly: percentMeterToWindow(payload.usage.monthly, MONTHLY_WINDOW_MINUTES)
  }
}

export function parseOpenCodeGoStatusPayload(text: string): OpenCodeGoUsageWindows | null {
  if (!text || text.length > MAX_STATUS_PAYLOAD_CHARS) {
    return null
  }

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }

  if (!isRecord(payload) || !isRecord(payload.access) || !isRecord(payload.access.meters)) {
    return null
  }

  const meters = payload.access.meters
  const session = meterToWindow(meters.fiveHour, SESSION_WINDOW_MINUTES)
  const weekly = meterToWindow(meters.week, WEEKLY_WINDOW_MINUTES)
  if (!session || !weekly) {
    return null
  }

  return {
    session,
    weekly,
    monthly: meterToWindow(meters.month, MONTHLY_WINDOW_MINUTES)
  }
}
