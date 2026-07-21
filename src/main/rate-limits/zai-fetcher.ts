import { net } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const ZAI_USAGE_ENDPOINT = 'https://api.z.ai/api/monitor/usage/quota/limit'
const API_TIMEOUT_MS = 15_000
const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10080
const MONTHLY_WINDOW_MINUTES = 43200
const ZAI_USAGE_UNAVAILABLE_MESSAGE = 'Z.ai usage data is currently unavailable'
const ZAI_USAGE_PARSE_ERROR_MESSAGE = 'Invalid Z.ai usage response'
const ZAI_USAGE_NETWORK_ERROR_MESSAGE = 'Z.ai usage request failed'

type ZaiQuotaEntry = {
  quotaType?: unknown
  type?: unknown
  unit?: unknown
  number?: unknown
  percentage?: unknown
  nextResetTime?: unknown
}

type ZaiUsagePayload = {
  success?: unknown
  code?: unknown
  message?: unknown
  msg?: unknown
  data?:
    | {
        limits?: unknown
        quotaLimits?: unknown
        quotas?: unknown
        list?: unknown
      }
    | unknown
}

export type FetchZaiRateLimitsOptions = {
  apiKey: string
  /** Test-only endpoint override. Production wiring always uses the fixed endpoint. */
  endpoint?: string
  signal?: AbortSignal
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function makeUnavailable(error: string): ProviderRateLimits {
  return {
    provider: 'zai',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status: 'unavailable',
    usageMetadata: { failureKind: 'missing-credentials', source: 'web' }
  }
}

function makeError(
  error: string,
  failureKind: NonNullable<ProviderRateLimits['usageMetadata']>['failureKind']
): ProviderRateLimits {
  return {
    provider: 'zai',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: { failureKind, source: 'web' }
  }
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

function asQuotaEntries(data: ZaiUsagePayload['data']): ZaiQuotaEntry[] {
  if (Array.isArray(data)) {
    return data.filter(
      (entry): entry is ZaiQuotaEntry => typeof entry === 'object' && entry !== null
    )
  }
  const dataRecord = asRecord(data)
  if (!dataRecord) {
    return []
  }
  const candidates = [dataRecord.limits, dataRecord.quotaLimits, dataRecord.quotas, dataRecord.list]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(
        (entry): entry is ZaiQuotaEntry => typeof entry === 'object' && entry !== null
      )
    }
  }
  return []
}

function parseResetTime(value: unknown): number | null {
  const numeric = asNumber(value)
  if (numeric !== null) {
    if (numeric <= 0) {
      return null
    }
    // Why: quota payloads in the wild contain both Unix seconds and milliseconds.
    // Normalizing here prevents valid second epochs from rendering as 1970 dates.
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
  }
  const text = asString(value)
  if (!text) {
    return null
  }
  const timestamp = Date.parse(text)
  return Number.isFinite(timestamp) ? timestamp : null
}

function parseQuotaWindow(entry: ZaiQuotaEntry): RateLimitWindow | null {
  const quotaType = asString(entry.quotaType) ?? asString(entry.type)
  const unit = asNumber(entry.unit)
  const number = asNumber(entry.number)
  const percentage = asNumber(entry.percentage)
  if (!quotaType || unit === null || number === null || percentage === null) {
    return null
  }
  if (quotaType === 'TOKENS_LIMIT' && unit === 3 && number === 5) {
    return {
      usedPercent: clampPercent(percentage),
      windowMinutes: SESSION_WINDOW_MINUTES,
      resetsAt: parseResetTime(entry.nextResetTime),
      resetDescription: null
    }
  }
  // Why: weekly payloads use both 1 and 7 for `number`; unit 6 is the stable discriminator.
  if (quotaType === 'TOKENS_LIMIT' && unit === 6) {
    return {
      usedPercent: clampPercent(percentage),
      windowMinutes: WEEKLY_WINDOW_MINUTES,
      resetsAt: parseResetTime(entry.nextResetTime),
      resetDescription: null
    }
  }
  if (quotaType === 'TIME_LIMIT' && unit === 5 && number === 1) {
    return {
      usedPercent: clampPercent(percentage),
      windowMinutes: MONTHLY_WINDOW_MINUTES,
      resetsAt: parseResetTime(entry.nextResetTime),
      resetDescription: null
    }
  }
  return null
}

function extractQuotaWindows(payload: ZaiUsagePayload): {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  monthly: RateLimitWindow | null
} {
  let session: RateLimitWindow | null = null
  let weekly: RateLimitWindow | null = null
  let monthly: RateLimitWindow | null = null
  for (const entry of asQuotaEntries(payload.data)) {
    const window = parseQuotaWindow(entry)
    if (!window) {
      continue
    }
    if (window.windowMinutes === SESSION_WINDOW_MINUTES) {
      session = window
      continue
    }
    if (window.windowMinutes === WEEKLY_WINDOW_MINUTES) {
      weekly = window
      continue
    }
    if (window.windowMinutes === MONTHLY_WINDOW_MINUTES) {
      monthly = window
    }
  }
  return { session, weekly, monthly }
}

function payloadSucceeded(payload: ZaiUsagePayload): boolean {
  const code = asNumber(payload.code)
  if (payload.success === false) {
    return false
  }
  if (code !== null && code !== 0 && code !== 200) {
    return false
  }
  if (payload.success === true) {
    return true
  }
  if (code === 0 || code === 200) {
    return true
  }
  return asQuotaEntries(payload.data).length > 0
}

function payloadFailureKind(
  payload: ZaiUsagePayload
): NonNullable<ProviderRateLimits['usageMetadata']>['failureKind'] {
  // Why: this endpoint reports auth/rate-limit failures as business codes inside HTTP 200.
  const code = asNumber(payload.code)
  if (code === 401 || code === 403) {
    return 'stale-token'
  }
  if (code === 429) {
    return 'rate-limited'
  }
  if (code !== null && code >= 500) {
    return 'server'
  }
  return 'usage-unavailable'
}

export async function fetchZaiRateLimits(
  options: FetchZaiRateLimitsOptions
): Promise<ProviderRateLimits> {
  const apiKey = options.apiKey.trim()
  if (!apiKey) {
    return makeUnavailable('Z.ai API key not configured')
  }
  try {
    const requestSignal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(API_TIMEOUT_MS)])
      : AbortSignal.timeout(API_TIMEOUT_MS)
    const response = await net.fetch(options.endpoint ?? ZAI_USAGE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      },
      redirect: 'error',
      signal: requestSignal
    })
    if (response.status === 401 || response.status === 403) {
      return makeError('Z.ai API key expired or unauthorized', 'stale-token')
    }
    if (response.status === 429) {
      return makeError('Z.ai usage request was rate limited', 'rate-limited')
    }
    if (!response.ok) {
      return makeError(`Z.ai usage request failed (${response.status})`, 'server')
    }
    let payload: ZaiUsagePayload
    try {
      const decoded: unknown = await response.json()
      const payloadRecord = asRecord(decoded)
      if (!payloadRecord) {
        return makeError(ZAI_USAGE_PARSE_ERROR_MESSAGE, 'parse')
      }
      payload = payloadRecord
    } catch {
      return makeError(ZAI_USAGE_PARSE_ERROR_MESSAGE, 'parse')
    }
    if (!payloadSucceeded(payload)) {
      const failureKind = payloadFailureKind(payload)
      const message =
        failureKind === 'stale-token'
          ? 'Z.ai API key expired or unauthorized'
          : ZAI_USAGE_UNAVAILABLE_MESSAGE
      return makeError(message, failureKind)
    }
    const windows = extractQuotaWindows(payload)
    if (!windows.session) {
      return makeError(
        'Z.ai usage response did not include a 5-hour token quota window',
        'usage-unavailable'
      )
    }
    return {
      provider: 'zai',
      session: windows.session,
      weekly: windows.weekly,
      monthly: windows.monthly,
      updatedAt: Date.now(),
      error: null,
      status: 'ok',
      usageMetadata: { source: 'web' }
    }
  } catch {
    // Why: transport errors are not a trusted renderer boundary and may embed
    // request context; keep them fixed just like malformed response errors.
    return makeError(ZAI_USAGE_NETWORK_ERROR_MESSAGE, 'network')
  }
}
