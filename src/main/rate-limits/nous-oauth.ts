import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { getNousAuthPath, getNousSharedStorePath, type NousAuthSession } from './nous-auth'

export const API_TIMEOUT_MS = 15_000

// Why: keep the endpoint deadline while letting the caller abort a credentialed
// request (e.g. the service cycle signal) so stop() doesn't strand a live fetch.
export function withEndpointDeadline(signal: AbortSignal | undefined): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS)
}

// Why: Hermes refreshes 2 minutes before expiry; mirror that skew so a token
// that is about to die is not used for a 15-minute-cached status-bar snapshot.
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000

export type ResolvedNousAccessToken =
  | { token: string }
  | { error: string; kind: NonNullable<ProviderRateLimits['usageMetadata']>['failureKind'] }

export function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function isTokenFresh(session: NousAuthSession): boolean {
  if (session.expiresAtMs === null) {
    // Why: auth.json may lack expiry; a stale token still surfaces as 401.
    return true
  }
  return session.expiresAtMs - Date.now() > TOKEN_REFRESH_SKEW_MS
}

// ─── Refresh persistence ──────────────────────────────────────────────────
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
    dirname(path),
    `.nous-auth-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
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

export async function resolveAccessToken(
  session: NousAuthSession,
  signal?: AbortSignal
): Promise<ResolvedNousAccessToken> {
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
      // Why: never follow a redirect — a compromised portal response must not
      // exfiltrate the refresh token to a different origin (redirect: error).
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-nous-refresh-token': session.refreshToken
      },
      body: body.toString(),
      signal: withEndpointDeadline(signal)
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
