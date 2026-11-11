import type {
  ProviderRateLimits,
  RateLimitWindow,
  UsageRateLimitFailureKind
} from '../../../../shared/rate-limit-types'

// Muse plans meter a five-hour session window and a weekly allowance.
const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10_080

export type MuseUsageReading =
  | { kind: 'ok'; limits: ProviderRateLimits }
  | { kind: 'no-allowance'; failureKind: UsageRateLimitFailureKind; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestampMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function parseWindow(value: unknown, windowMinutes: number): RateLimitWindow | null | undefined {
  if (value == null) {
    return null
  }
  if (
    !isRecord(value) ||
    typeof value.usedPercent !== 'number' ||
    !Number.isFinite(value.usedPercent) ||
    value.usedPercent < 0 ||
    (value.resetsAtMs != null && !isTimestampMs(value.resetsAtMs))
  ) {
    return undefined
  }
  return {
    // Muse reports over-quota usage above 100; meters share the 0-100 contract.
    usedPercent: Math.min(100, Math.max(0, value.usedPercent)),
    windowMinutes,
    resetsAt: isTimestampMs(value.resetsAtMs) ? value.resetsAtMs : null,
    resetDescription: null
  }
}

function describeMissingAllowance(reason: unknown): {
  failureKind: UsageRateLimitFailureKind
  message: string
} {
  // Reason codes from Muse 1.4.14: api_key, no_allowance, server_sent_no_usage.
  if (reason === 'api_key') {
    return {
      failureKind: 'no-subscription',
      message: 'Muse usage is unavailable. Muse is signed in with an API key, not a subscription.'
    }
  }
  if (reason === 'no_allowance') {
    return {
      failureKind: 'no-subscription',
      message: 'Muse usage is unavailable. This account has no Muse subscription allowance.'
    }
  }
  return {
    failureKind: 'usage-unavailable',
    message: 'Muse usage is unavailable. Muse did not report a subscription allowance.'
  }
}

/** Parses `muse usage --json` (schemaVersion 1); returns null for anything that is not that shape. */
export function parseMuseUsageStdout(stdout: string, now: number): MuseUsageReading | null {
  let payload: unknown
  try {
    payload = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (!isRecord(payload) || payload.schemaVersion !== 1 || !('allowance' in payload)) {
    return null
  }
  const allowance = payload.allowance
  if (allowance === null) {
    return { kind: 'no-allowance', ...describeMissingAllowance(payload.reason) }
  }
  if (!isRecord(allowance)) {
    return null
  }
  const session = parseWindow(allowance.window, SESSION_WINDOW_MINUTES)
  const weekly = parseWindow(allowance.weekly, WEEKLY_WINDOW_MINUTES)
  if (session === undefined || weekly === undefined) {
    return null
  }
  if (!session && !weekly) {
    return { kind: 'no-allowance', ...describeMissingAllowance(payload.reason) }
  }
  return {
    kind: 'ok',
    limits: {
      provider: 'muse',
      session,
      weekly,
      // Fetch time drives refresh cadence; a cached older asOfMs must not read as stale.
      updatedAt: now,
      planType: typeof allowance.tier === 'string' && allowance.tier ? allowance.tier : null,
      error: null,
      status: 'ok',
      usageMetadata: { source: 'cli', attemptedSources: ['cli'] }
    }
  }
}
