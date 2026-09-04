import { net } from 'electron'
import type {
  ProviderRateLimits,
  RateLimitWindow,
  UsageRateLimitFailureKind
} from '../../shared/rate-limit-types'
import { readZaiCredentials } from './zai-credentials'

const API_TIMEOUT_MS = 10_000
const QUOTA_LIMIT_PATH = '/api/monitor/usage/quota/limit'

// Why: the status contract exposes only the two contracted windows (5h/7d),
// mirroring how Codex and MiniMax always report 300/10080 minutes regardless
// of what the payload's duration metadata drifts to.
const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10080

// Why: identical to the official glm-plan-usage plugin — raw key (no Bearer
// prefix) plus locale headers; the monitor endpoint authenticates by key only.
const ACCEPT_LANGUAGE = 'en-US,en'

// Z.ai duration metadata is a `(unit, number)` pair: 3=hour, 4=day, 5=month
// (30d), 6=week. Unknown units are ignored so a future window cannot hide
// meters that still parse.
const ZAI_UNIT_MS: Partial<Record<number, number>> = {
  3: 3_600_000,
  4: 86_400_000,
  5: 30 * 86_400_000,
  6: 7 * 86_400_000
}

// Why: a corrupt/hostile Retry-After must not gate usage refreshes for days.
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

// Why: raw provider/network error text can embed URLs or infrastructure
// details; the user only needs to know the request did not go through.
const GENERIC_NETWORK_ERROR = 'Z.ai usage request failed — check your network connection'

export type FetchZaiRateLimitsOptions = {
  /** Optional caller cancellation; combined with the bounded timeout. */
  signal?: AbortSignal
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

// Why: current payloads send epoch milliseconds but older revisions sent epoch
// seconds; a magnitude check tells the two apart.
function toEpochMs(value: unknown): number | null {
  const raw = asNumber(value)
  if (raw === null) {
    return null
  }
  if (raw >= 1e12) {
    return raw
  }
  if (raw >= 1e9) {
    return raw * 1000
  }
  return null
}

function limitEntryMinutes(entry: Record<string, unknown>): number | null {
  const unit = asNumber(entry.unit)
  const count = asNumber(entry.number)
  if (unit === null || count === null || count <= 0) {
    return null
  }
  const unitMs = ZAI_UNIT_MS[unit]
  return unitMs === undefined ? null : (unitMs * count) / 60_000
}

function contractedWindowMinutes(minutes: number): number | null {
  if (minutes === SESSION_WINDOW_MINUTES || minutes === WEEKLY_WINDOW_MINUTES) {
    return minutes
  }
  return null
}

type ZaiUsageWindow = RateLimitWindow

function mapQuotaEntry(entry: unknown): ZaiUsageWindow | null {
  const record = asObject(entry)
  if (!record) {
    return null
  }
  // Z.ai has matched entries by `type` or `name` across payload revisions.
  const kind = typeof record.type === 'string' ? record.type : record.name
  // Why: only percentage quota windows meter Coding Plan usage; TIME_LIMIT
  // (monthly web-search counts) and future kinds are not rate-limit data.
  if (kind !== 'CREDIT_LIMIT' && kind !== 'TOKENS_LIMIT') {
    return null
  }
  const percentage = asNumber(record.percentage)
  const minutes = limitEntryMinutes(record)
  const windowMinutes = minutes === null ? null : contractedWindowMinutes(minutes)
  if (percentage === null || windowMinutes === null) {
    return null
  }
  return {
    usedPercent: clampPercent(percentage),
    windowMinutes,
    resetsAt: toEpochMs(record.nextResetTime),
    resetDescription: null
  }
}

function unwrapQuotaLimits(data: unknown): unknown[] | null {
  const body = asObject(data)
  if (!body) {
    return null
  }
  // Wrapped payloads nest under `data` ({ success, data: { limits } }); older
  // ones expose `limits` at the top level.
  const limits = asObject(body.data)?.limits ?? body.limits
  return Array.isArray(limits) ? limits : null
}

function toRateLimitWindow(entry: ZaiUsageWindow): RateLimitWindow {
  return {
    usedPercent: entry.usedPercent,
    windowMinutes: entry.windowMinutes,
    resetsAt: entry.resetsAt,
    resetDescription: entry.resetDescription
  }
}

function mapQuotaResponse(
  data: unknown
): { session: RateLimitWindow | null; weekly: RateLimitWindow | null } | null {
  const limits = unwrapQuotaLimits(data)
  if (limits === null) {
    return null
  }
  let session: ZaiUsageWindow | null = null
  let weekly: ZaiUsageWindow | null = null
  for (const entry of limits) {
    const mapped = mapQuotaEntry(entry)
    if (!mapped) {
      continue
    }
    if (mapped.windowMinutes === SESSION_WINDOW_MINUTES) {
      session ??= mapped
    } else {
      weekly ??= mapped
    }
  }
  if (!session && !weekly) {
    return null
  }
  return {
    session: session ? toRateLimitWindow(session) : null,
    weekly: weekly ? toRateLimitWindow(weekly) : null
  }
}

// Mirrors the Claude usage parser: seconds or an HTTP-date (RFC 9110).
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) {
    return null
  }
  const seconds = Number(header)
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null
  }
  const dateMs = Date.parse(header)
  if (!Number.isFinite(dateMs)) {
    return null
  }
  const delta = dateMs - Date.now()
  return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_MS) : null
}

function isTimeoutError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'TimeoutError'
}

function usageMetadata(
  failureKind?: UsageRateLimitFailureKind,
  retryAtMs?: number
): ProviderRateLimits['usageMetadata'] {
  return {
    source: 'web',
    ...(failureKind ? { failureKind } : {}),
    ...(retryAtMs !== undefined ? { retryAtMs } : {})
  }
}

function makeUnavailable(error: string): ProviderRateLimits {
  return {
    provider: 'zai',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'unavailable',
    usageMetadata: usageMetadata('missing-credentials')
  }
}

function makeError(
  error: string,
  failureKind: UsageRateLimitFailureKind,
  retryAtMs?: number
): ProviderRateLimits {
  return {
    provider: 'zai',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: usageMetadata(failureKind, retryAtMs)
  }
}

/**
 * Read-only usage for the OpenCode Z.AI Coding Plan (`zai-coding-plan` in
 * OpenCode's auth.json). Orca never refreshes or rewrites that key — it is
 * owned by `opencode auth login`. The quota endpoint is the same monitor API
 * the official glm-plan-usage plugin calls.
 */
export async function fetchZaiRateLimits(
  options?: FetchZaiRateLimitsOptions
): Promise<ProviderRateLimits> {
  const credentials = await readZaiCredentials()
  if (credentials.status === 'missing') {
    return makeUnavailable(
      'Z.ai Coding Plan key not found — run "opencode auth login" and add Z.ai'
    )
  }
  if (credentials.status === 'error') {
    return makeError(credentials.error, 'unknown')
  }
  const { key, origin } = credentials
  // Why: same combination shape as the codex/claude fetchers — caller
  // cancellation plus one bounded timeout, whichever fires first.
  const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS)
  const signal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  try {
    const response = await net.fetch(`${origin.replace(/\/$/, '')}${QUOTA_LIMIT_PATH}`, {
      method: 'GET',
      headers: {
        Authorization: key,
        'Accept-Language': ACCEPT_LANGUAGE,
        'Content-Type': 'application/json'
      },
      signal
    })
    if (response.status === 401 || response.status === 403) {
      return makeError(
        `Z.ai rejected the Coding Plan key (HTTP ${response.status}) — run "opencode auth login" to refresh it`,
        'stale-token'
      )
    }
    if (response.status === 429) {
      // Why: activation refreshes honor Retry-After; the metadata contract wants
      // an absolute timestamp, so convert the parsed delta.
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
      return makeError(
        'Z.ai usage is rate limited right now',
        'rate-limited',
        retryAfterMs === null ? undefined : Date.now() + retryAfterMs
      )
    }
    if (!response.ok) {
      return makeError(
        `Z.ai usage request failed (HTTP ${response.status})`,
        response.status >= 500 ? 'server' : 'unknown'
      )
    }
    let data: unknown
    try {
      data = await response.json()
    } catch {
      return makeError('Z.ai usage response is not valid JSON', 'parse')
    }
    const windows = mapQuotaResponse(data)
    if (!windows) {
      return makeError(
        'Z.ai usage response did not include recognized quota windows',
        'usage-unavailable'
      )
    }
    return {
      provider: 'zai',
      session: windows.session,
      weekly: windows.weekly,
      updatedAt: Date.now(),
      error: null,
      status: 'ok',
      usageMetadata: usageMetadata()
    }
  } catch (error) {
    if (isTimeoutError(error)) {
      return makeError(`Z.ai usage request timed out after ${API_TIMEOUT_MS / 1000}s`, 'network')
    }
    return makeError(GENERIC_NETWORK_ERROR, 'network')
  }
}
