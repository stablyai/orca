import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const MUSE_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60

/** Wire shape of MSP `usage/read` / `usage/changed` (Muse Code >= 1.4.0). */
export type MuseSubscriptionUsage = {
  observedAtMs: number
  tier: string
  window: {
    usedPercent: number
    windowDurationMins: number
    resetsAtMs: number
  }
  weekly: { usedPercent: number; resetsAtMs: number }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function parseMuseSubscriptionUsage(value: unknown): MuseSubscriptionUsage | null {
  if (!isRecord(value) || !isRecord(value.window) || !isRecord(value.weekly)) {
    return null
  }
  const { window, weekly } = value
  if (
    !isFiniteNumber(window.usedPercent) ||
    !isFiniteNumber(window.windowDurationMins) ||
    !isFiniteNumber(window.resetsAtMs) ||
    !isFiniteNumber(weekly.usedPercent) ||
    !isFiniteNumber(weekly.resetsAtMs)
  ) {
    return null
  }
  return {
    observedAtMs: isFiniteNumber(value.observedAtMs) ? value.observedAtMs : Date.now(),
    tier: typeof value.tier === 'string' ? value.tier : '',
    window: {
      usedPercent: window.usedPercent,
      windowDurationMins: window.windowDurationMins,
      resetsAtMs: window.resetsAtMs
    },
    weekly: { usedPercent: weekly.usedPercent, resetsAtMs: weekly.resetsAtMs }
  }
}

function toWindow(usedPercent: number, windowMinutes: number, resetsAt: number): RateLimitWindow {
  // Why clamp: Muse reports over-quota values above 100 verbatim; the meter is 0–100.
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowMinutes,
    resetsAt,
    resetDescription: null
  }
}

export function mapMuseUsage(usage: MuseSubscriptionUsage): ProviderRateLimits {
  return {
    provider: 'muse',
    session: toWindow(
      usage.window.usedPercent,
      usage.window.windowDurationMins,
      usage.window.resetsAtMs
    ),
    weekly: toWindow(usage.weekly.usedPercent, MUSE_WEEKLY_WINDOW_MINUTES, usage.weekly.resetsAtMs),
    updatedAt: usage.observedAtMs,
    error: null,
    status: 'ok',
    usageMetadata: { source: 'cli' }
  }
}
