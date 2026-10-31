import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && value > 0 && Number.isFinite(new Date(value).getTime())
}

function parseWindow(value: unknown, defaultMinutes: number): RateLimitWindow | null | undefined {
  if (value == null) {
    return null
  }
  if (
    !isRecord(value) ||
    typeof value.usedPercent !== 'number' ||
    !Number.isFinite(value.usedPercent) ||
    value.usedPercent < 0 ||
    (value.windowDurationMins != null &&
      (typeof value.windowDurationMins !== 'number' ||
        !Number.isFinite(value.windowDurationMins) ||
        value.windowDurationMins <= 0)) ||
    (value.resetsAtMs != null && !isTimestamp(value.resetsAtMs))
  ) {
    return undefined
  }
  return {
    usedPercent: value.usedPercent,
    windowMinutes:
      typeof value.windowDurationMins === 'number' ? value.windowDurationMins : defaultMinutes,
    resetsAt: isTimestamp(value.resetsAtMs) ? value.resetsAtMs : null,
    resetDescription: null
  }
}

export function parseMuseUsageStdout(stdout: string, now: number): ProviderRateLimits | null {
  let payload: unknown
  try {
    payload = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isRecord(payload) || payload.schemaVersion !== 1 || !Object.hasOwn(payload, 'allowance')) {
    return null
  }
  const base = {
    provider: 'muse',
    session: null,
    weekly: null,
    updatedAt: now,
    usageMetadata: { source: 'cli', attemptedSources: ['cli'] }
  } satisfies Partial<ProviderRateLimits>
  const unavailable = (): ProviderRateLimits => ({
    ...base,
    status: 'unavailable',
    error: 'Muse did not report a subscription allowance.',
    usageMetadata: { ...base.usageMetadata, failureKind: 'usage-unavailable' }
  })
  if (payload.allowance === null) {
    return unavailable()
  }
  if (!isRecord(payload.allowance)) {
    return null
  }
  const allowance = payload.allowance
  // Muse's five-hour sessions and weekly allowances: https://dev.meta.ai/docs/muse-code/subscriptions
  const session = parseWindow(allowance.window, 300)
  const weekly = parseWindow(allowance.weekly, 10_080)
  if (
    session === undefined ||
    weekly === undefined ||
    (allowance.asOfMs != null && !isTimestamp(allowance.asOfMs))
  ) {
    return null
  }
  if (!session && !weekly) {
    return unavailable()
  }
  return {
    ...base,
    session,
    weekly,
    updatedAt: isTimestamp(allowance.asOfMs) ? Math.min(allowance.asOfMs, now) : now,
    planType: typeof allowance.tier === 'string' ? allowance.tier : null,
    status: 'ok',
    error: null
  }
}
