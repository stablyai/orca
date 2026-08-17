import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import {
  getNousAuthPath,
  getNousSharedStorePath,
  readNousAuthSession,
  type NousAuthReadResult,
  type NousAuthSession
} from './nous-auth'

const API_TIMEOUT_MS = 15_000
// Why: Hermes refreshes 2 minutes before expiry; mirror that skew so a token
// that is about to die is not used for a 15-minute-cached status-bar snapshot.
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000
// Why: the portal subscription runs on a calendar-month cycle (cycleEndsAt).
const NOUS_MONTHLY_WINDOW_MINUTES = 43_200

export type FetchNousRateLimitsOptions = {
  authReadResult?: NousAuthReadResult
}

type NousSubscriptionPayload = {
  current?: {
    tierId?: unknown
    tierName?: unknown
    monthlyCredits?: unknown
    creditsRemaining?: unknown
    cycleEndsAt?: unknown
  } | null
}

function makeUnavailable(error: string): ProviderRateLimits {
  return {
    provider: 'nous',
    session: null,
    weekly: null,
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
    provider: 'nous',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: { failureKind, source: 'web' }
  }
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

// Why: credits are decimal end-to-end; round to one decimal so the bar text
// stays compact ("580 | 420", "142.5") without drifting float artifacts.
function roundAmount(value: number): number {
  return Math.round(value * 10) / 10
}

function isTokenFresh(session: NousAuthSession): boolean {
  if (session.expiresAtMs === null) {
    // Why: auth.json may lack expiry; a stale token still surfaces as 401.
    return true
  }
  return session.expiresAtMs - Date.now() > TOKEN_REFRESH_SKEW_MS
}

// ─── Refresh + persistence ────────────────────────────────────────────────
// Why: the portal can rotate refresh tokens, and Hermes merges the shared
// store over the profile-local auth.json when their refresh tokens differ —
// so a refresh must persist BOTH files atomically, or the next Hermes run
// would resurrect the stale token. Both writes are best-effort: a failed
// write still leaves the in-memory token usable for this request.

function readJsonQuiet(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) {
      return null
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function writeJsonAtomically(path: string, payload: unknown): void {
  const json = `${JSON.stringify(payload, null, 2)}\n`
  const tmpPath = join(
    tmpdir(),
    `nous-auth-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
  )
  writeFileSync(tmpPath, json, { mode: 0o600 })
  try {
    renameSync(tmpPath, path)
  } catch {
    // Why: rename-over-existing can fail on Windows; a direct write still
    // lands the fresh token (best-effort — no partial-file corruption risk
    // on POSIX, where rename is atomic).
    try {
      writeFileSync(path, json, { mode: 0o600 })
    } finally {
      rmSync(tmpPath, { force: true })
    }
  }
}

function persistNousRefresh(session: NousAuthSession, refreshed: Record<string, unknown>): void {
  const nowIso = new Date().toISOString()
  const accessToken = typeof refreshed.access_token === 'string' ? refreshed.access_token : ''
  const refreshToken =
    typeof refreshed.refresh_token === 'string' && refreshed.refresh_token
      ? refreshed.refresh_token
      : session.refreshToken
  const expiresIn = asFiniteNumber(refreshed.expires_in)
  const expiresAtIso =
    expiresIn !== null ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined
  if (!accessToken || !refreshToken) {
    return
  }

  const authPath = getNousAuthPath()
  const auth = readJsonQuiet(authPath)
  const providers = auth?.providers
  if (auth && typeof providers === 'object' && providers !== null) {
    const nous = (providers as Record<string, unknown>).nous as Record<string, unknown> | undefined
    ;(providers as Record<string, unknown>).nous = {
      ...(nous as Record<string, unknown>),
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: refreshed.token_type ?? nous?.token_type ?? 'Bearer',
      obtained_at: nowIso,
      ...(expiresAtIso ? { expires_at: expiresAtIso } : {}),
      ...(expiresIn !== null ? { expires_in: expiresIn } : {})
    }
    writeJsonAtomically(authPath, auth)
  }

  const sharedPath = getNousSharedStorePath()
  const shared = readJsonQuiet(sharedPath)
  if (shared) {
    shared.access_token = accessToken
    shared.refresh_token = refreshToken
    if (expiresAtIso) {
      shared.expires_at = expiresAtIso
    }
    shared.updated_at = nowIso
    try {
      mkdirSync(dirname(sharedPath), { recursive: true })
      writeJsonAtomically(sharedPath, shared)
    } catch {
      // best-effort — a stale shared copy self-heals on the next Hermes refresh
    }
  }
}

async function resolveAccessToken(
  session: NousAuthSession
): Promise<
  | { token: string }
  | { error: string; kind: NonNullable<ProviderRateLimits['usageMetadata']>['failureKind'] }
> {
  if (isTokenFresh(session)) {
    return { token: session.accessToken }
  }
  if (!session.refreshToken) {
    return {
      error: 'Nous Portal session expired — run `hermes portal` to sign in again.',
      kind: 'stale-token'
    }
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: session.clientId
  })
  try {
    const response = await fetch(`${session.portalBaseUrl}/api/oauth/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-nous-refresh-token': session.refreshToken
      },
      body: body.toString(),
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
    if (!response.ok) {
      return {
        error: `Nous Portal token refresh failed (${response.status}).`,
        kind: 'stale-token'
      }
    }
    const payload: unknown = await response.json()
    if (typeof payload !== 'object' || payload === null) {
      return { error: 'Nous Portal token refresh returned an invalid response.', kind: 'parse' }
    }
    const token = (payload as Record<string, unknown>).access_token
    if (typeof token !== 'string' || !token) {
      return { error: 'Nous Portal token refresh returned no access token.', kind: 'parse' }
    }
    persistNousRefresh(session, payload as Record<string, unknown>)
    return { token }
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? `Could not reach Nous Portal: ${error.message}`
          : 'Could not reach Nous Portal.',
      kind: 'network'
    }
  }
}

// ─── Subscription fetch ────────────────────────────────────────────────────

function parseCycleEndsAt(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function buildMonthlyWindow(current: NousSubscriptionPayload['current']): RateLimitWindow | null {
  if (!current) {
    return null
  }
  const monthlyCredits = asFiniteNumber(current.monthlyCredits)
  const creditsRemaining = asFiniteNumber(current.creditsRemaining)
  if (monthlyCredits === null || creditsRemaining === null || monthlyCredits <= 0) {
    return null
  }
  const used = Math.max(0, monthlyCredits - creditsRemaining)
  return {
    usedPercent: clampPercent((used / monthlyCredits) * 100),
    windowMinutes: NOUS_MONTHLY_WINDOW_MINUTES,
    resetsAt: parseCycleEndsAt(current.cycleEndsAt),
    resetDescription: null,
    usedAmount: roundAmount(used),
    remainingAmount: roundAmount(creditsRemaining)
  }
}

export async function fetchNousRateLimits(
  options: FetchNousRateLimitsOptions = {}
): Promise<ProviderRateLimits> {
  const authReadResult = options.authReadResult ?? readNousAuthSession()
  if (authReadResult.status !== 'ok') {
    return makeUnavailable(
      authReadResult.status === 'error'
        ? authReadResult.error
        : 'Nous Portal login not found — run `hermes portal` to sign in.'
    )
  }
  const resolved = await resolveAccessToken(authReadResult.session)
  if ('error' in resolved) {
    return makeError(resolved.error, resolved.kind)
  }
  try {
    const response = await fetch(
      `${authReadResult.session.portalBaseUrl}/api/billing/subscription`,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${resolved.token}`
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      }
    )
    if (response.status === 401 || response.status === 403) {
      return makeError(
        'Nous Portal session expired — run `hermes portal` to sign in again.',
        'stale-token'
      )
    }
    if (!response.ok) {
      return makeError(`Nous Portal usage fetch failed (${response.status})`, 'server')
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid Nous Portal usage response'
      return makeError(message, 'parse')
    }
    if (typeof payload !== 'object' || payload === null) {
      return makeError('Nous Portal usage returned an invalid response.', 'parse')
    }
    const current = (payload as NousSubscriptionPayload).current
    const tierName =
      current && typeof current.tierName === 'string' && current.tierName.trim()
        ? current.tierName.trim()
        : null
    return {
      provider: 'nous',
      session: null,
      weekly: null,
      monthly: buildMonthlyWindow(current),
      planType: tierName,
      updatedAt: Date.now(),
      error: null,
      status: 'ok',
      usageMetadata: { source: 'web' }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Nous Portal usage error'
    return makeError(message, 'network')
  }
}
