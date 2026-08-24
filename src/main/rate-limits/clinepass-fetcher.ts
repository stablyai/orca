import { net } from 'electron'
import type {
  ProviderRateLimits,
  RateLimitWindow,
  UsageRateLimitFailureKind,
  UsageRateLimitMetadata
} from '../../shared/rate-limit-types'

// Why: ClinePass plan usage is a single bearer-auth JSON endpoint — no scraping or OAuth refresh.
const USAGE_LIMITS_URL = 'https://api.cline.bot/api/v1/users/me/plan/usage-limits'
const API_TIMEOUT_MS = 15_000
// Why: a hostile Retry-After must not gate refreshes for days.
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

const WINDOW_MINUTES = {
  five_hour: 300,
  weekly: 10_080,
  monthly: 43_200
} as const

type ClinePassLimitType = keyof typeof WINDOW_MINUTES

const PROVIDER: ProviderRateLimits['provider'] = 'clinepass'

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  usageMetadata?: UsageRateLimitMetadata,
  windows?: {
    session?: RateLimitWindow | null
    weekly?: RateLimitWindow | null
    monthly?: RateLimitWindow | null
  }
): ProviderRateLimits {
  return {
    provider: PROVIDER,
    session: windows?.session ?? null,
    weekly: windows?.weekly ?? null,
    monthly: windows?.monthly ?? null,
    updatedAt: Date.now(),
    error,
    status,
    ...(usageMetadata ? { usageMetadata } : {})
  }
}

function makeError(
  error: string,
  failureKind: UsageRateLimitFailureKind,
  extra?: Pick<UsageRateLimitMetadata, 'retryAtMs'>
): ProviderRateLimits {
  return result('error', error, { failureKind, source: 'web', ...extra })
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) {
    return null
  }
  const seconds = Number(header)
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null
  }
  // Why: Retry-After may also be an HTTP-date (RFC 9110).
  const dateMs = Date.parse(header)
  if (!Number.isFinite(dateMs)) {
    return null
  }
  const delta = dateMs - Date.now()
  return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_MS) : null
}

function parseResetDescription(isoString: string): string | null {
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function isKnownLimitType(type: unknown): type is ClinePassLimitType {
  return type === 'five_hour' || type === 'weekly' || type === 'monthly'
}

function parseLimit(entry: unknown): { type: ClinePassLimitType; window: RateLimitWindow } | null {
  if (typeof entry !== 'object' || entry === null) {
    return null
  }
  const record = entry as Record<string, unknown>
  if (!isKnownLimitType(record.type)) {
    return null
  }
  const percentUsed = record.percentUsed
  if (typeof percentUsed !== 'number' || !Number.isFinite(percentUsed)) {
    return null
  }
  const resetsAtRaw = record.resetsAt
  if (typeof resetsAtRaw !== 'string' || !resetsAtRaw.trim()) {
    return null
  }
  const resetsAt = Date.parse(resetsAtRaw)
  if (!Number.isFinite(resetsAt)) {
    return null
  }
  return {
    type: record.type,
    window: {
      usedPercent: Math.max(0, Math.min(100, percentUsed)),
      windowMinutes: WINDOW_MINUTES[record.type],
      resetsAt,
      resetDescription: parseResetDescription(resetsAtRaw)
    }
  }
}

function redactApiKey(message: string, apiKey: string): string {
  return apiKey && message.includes(apiKey) ? message.split(apiKey).join('[redacted]') : message
}

/**
 * Read-only ClinePass subscription quota via the plan usage-limits API.
 *
 * Never throws for expected provider failures — always returns ProviderRateLimits.
 */
export async function fetchClinePassRateLimits(
  apiKey: string,
  options?: { signal?: AbortSignal }
): Promise<ProviderRateLimits> {
  const key = apiKey.trim()
  if (!key) {
    return result('unavailable', 'ClinePass API key not configured', {
      failureKind: 'missing-credentials',
      source: 'web'
    })
  }

  try {
    const requestSignal = options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(API_TIMEOUT_MS)])
      : AbortSignal.timeout(API_TIMEOUT_MS)
    const res = await net.fetch(USAGE_LIMITS_URL, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json'
      },
      signal: requestSignal
    })

    if (res.status === 401 || res.status === 403) {
      return makeError(`ClinePass usage request unauthorized (HTTP ${res.status})`, 'stale-token')
    }
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
      return makeError(
        'ClinePass usage is rate limited right now.',
        'rate-limited',
        retryAfterMs ? { retryAtMs: Date.now() + retryAfterMs } : undefined
      )
    }
    if (!res.ok) {
      return makeError(`ClinePass usage fetch failed (HTTP ${res.status})`, 'server')
    }

    let payload: unknown
    try {
      payload = await res.json()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid ClinePass usage response'
      return makeError(redactApiKey(message, key), 'parse')
    }

    if (typeof payload !== 'object' || payload === null) {
      return makeError('ClinePass usage response was malformed', 'parse')
    }
    const body = payload as Record<string, unknown>
    if (body.success !== true) {
      return makeError('ClinePass usage response was malformed', 'parse')
    }
    const data = body.data
    if (typeof data !== 'object' || data === null) {
      return makeError('ClinePass usage response was malformed', 'parse')
    }
    const limits = (data as Record<string, unknown>).limits
    if (!Array.isArray(limits)) {
      return makeError('ClinePass usage response was malformed', 'parse')
    }

    let session: RateLimitWindow | null = null
    let weekly: RateLimitWindow | null = null
    let monthly: RateLimitWindow | null = null
    let knownValid = 0
    for (const entry of limits) {
      const parsed = parseLimit(entry)
      if (!parsed) {
        continue
      }
      knownValid += 1
      if (parsed.type === 'five_hour') {
        session = parsed.window
      } else if (parsed.type === 'weekly') {
        weekly = parsed.window
      } else {
        monthly = parsed.window
      }
    }
    if (knownValid === 0) {
      return makeError('ClinePass usage response did not include quota windows', 'parse')
    }

    return result('ok', null, { source: 'web' }, { session, weekly, monthly })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ClinePass usage request failed'
    return makeError(redactApiKey(message, key), 'network')
  }
}
