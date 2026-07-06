import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { net } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

// Why: Kimi Code's managed coding plan exposes subscription usage at
// `${base}/usages` (see packages/oauth/src/managed-usage.ts in the CLI bundle).
// The base URL is overridable via the same env var the CLI honours so Orca
// stays aligned with a user's self-hosted/staging config.
const KIMI_BASE_URL = process.env.KIMI_CODE_BASE_URL ?? 'https://api.kimi.com/coding/v1'
const API_TIMEOUT_MS = 10_000

const SESSION_WINDOW_MINUTES = 300 // 5h
const WEEKLY_WINDOW_MINUTES = 10080 // 7d

function getKimiHome(): string {
  // Why: match the CLI's `KIMI_CODE_HOME ?? ~/.kimi-code` resolution so we read
  // the same OAuth credentials the running Kimi CLI writes.
  return process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code')
}

function getCredentialsPath(): string {
  return join(getKimiHome(), 'credentials', 'kimi-code.json')
}

type KimiCredentials = {
  access_token?: string
  expires_at?: number
}

type CredentialsReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; credentials: KimiCredentials }

function parseCredentials(value: unknown): KimiCredentials | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const credentials: KimiCredentials = {}
  if ('access_token' in value && typeof value.access_token === 'string') {
    credentials.access_token = value.access_token
  }
  if ('expires_at' in value && typeof value.expires_at === 'number') {
    credentials.expires_at = value.expires_at
  }
  return credentials
}

function readCredentials(): CredentialsReadResult {
  const path = getCredentialsPath()
  if (!existsSync(path)) {
    return { status: 'missing' }
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    const credentials = parseCredentials(parsed)
    return credentials
      ? { status: 'ok', credentials }
      : { status: 'error', error: 'Kimi credentials file is invalid' }
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : 'Unable to read Kimi credentials'
    }
  }
}

function isAccessTokenFresh(creds: KimiCredentials): boolean {
  return (
    typeof creds.access_token === 'string' &&
    creds.access_token.length > 0 &&
    typeof creds.expires_at === 'number' &&
    // Why: small skew margin so we don't fire a request against a token that
    // expires mid-flight. The CLI refreshes the file on its next run.
    creds.expires_at - Math.floor(Date.now() / 1000) > 5
  )
}

// ---------------------------------------------------------------------------
// Usage payload parsing (see packages/oauth/src/managed-usage.ts in the CLI)
// ---------------------------------------------------------------------------

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
  if (isNaN(date.getTime())) {
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

function mapUsageResponse(data: KimiUsageResponse): ProviderRateLimits {
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

function result(status: ProviderRateLimits['status'], error: string | null): ProviderRateLimits {
  return { provider: 'kimi', session: null, weekly: null, updatedAt: Date.now(), error, status }
}

/**
 * Read-only subscription usage for Kimi Code.
 *
 * Why read-only: the access token lives in `~/.kimi-code/credentials/kimi-code.json`
 * and is refreshed by the Kimi CLI itself (15-min TTL, refresh-token rotation).
 * Orca must NEVER refresh or rewrite that file — a rotated refresh token would
 * log out a live `kimi` session. We only read the current token and call the
 * same `GET /usages` endpoint, with the same headers, that the CLI's own
 * `/usage` command uses. The completion endpoint (the one Moonshot gates to
 * approved coding agents) is never touched here.
 */
export async function fetchKimiRateLimits(): Promise<ProviderRateLimits> {
  const readResult = readCredentials()
  if (readResult.status === 'missing') {
    return result('unavailable', 'Not signed in to Kimi Code')
  }
  if (readResult.status === 'error') {
    return result('error', readResult.error)
  }
  const creds = readResult.credentials
  if (typeof creds.access_token !== 'string' || creds.access_token.length === 0) {
    return result('error', 'Kimi credentials file is missing an access token')
  }
  if (!isAccessTokenFresh(creds)) {
    // Why: don't refresh — the CLI owns the token lifecycle. Report a transient
    // error so the rate-limit service keeps the last good snapshot (stale
    // policy) until the user next runs Kimi and the CLI refreshes the file.
    return result('error', 'Kimi token expired — open Kimi to refresh')
  }

  try {
    const res = await net.fetch(`${KIMI_BASE_URL.replace(/\/$/, '')}/usages`, {
      // Why: identical to the CLI's fetchManagedUsage — bearer token + Accept.
      // No extra User-Agent: the usages endpoint authenticates by token only.
      headers: { Authorization: `Bearer ${creds.access_token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
    if (res.status === 401 || res.status === 403) {
      return result('error', `Kimi usage request unauthorized (HTTP ${res.status})`)
    }
    if (!res.ok) {
      return result('error', `Kimi usage request failed (HTTP ${res.status})`)
    }
    const data: unknown = await res.json()
    return mapUsageResponse(typeof data === 'object' && data !== null ? data : {})
  } catch (err) {
    return result('error', err instanceof Error ? err.message : 'Kimi usage request failed')
  }
}
