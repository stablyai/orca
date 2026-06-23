import { net, session } from 'electron'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'

// Why: the OAuth client id and token endpoint are the public Claude Code
// values, verified against the installed `claude` binary (2.1.177) and the
// claude-swap reference tool. Orca owns the refresh so a single-use refresh
// token is rotated and persisted atomically, instead of being scraped back
// after the CLI rotates it (the lossy path that strands stale tokens).
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

// Refresh slightly ahead of expiry so a token doesn't expire mid-launch. The
// CLI uses the same 5-minute skew for its own refresh decision.
const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000
const REFRESH_TIMEOUT_MS = 10_000

type ClaudeOauthBlob = {
  accessToken?: unknown
  refreshToken?: unknown
  expiresAt?: unknown
  scopes?: unknown
  [key: string]: unknown
}

type ClaudeCredentials = {
  claudeAiOauth?: ClaudeOauthBlob
  [key: string]: unknown
}

type TokenEndpointResponse = {
  access_token?: unknown
  expires_in?: unknown
  refresh_token?: unknown
  scope?: unknown
}

/**
 * Parse the `claudeAiOauth` object from a credentials JSON string.
 * Returns null when the string is not parseable or lacks the OAuth block.
 */
export function parseClaudeOauthBlob(credentialsJson: string): ClaudeOauthBlob | null {
  try {
    const parsed = JSON.parse(credentialsJson) as ClaudeCredentials
    const oauth = parsed?.claudeAiOauth
    return oauth && typeof oauth === 'object' && !Array.isArray(oauth) ? oauth : null
  } catch {
    return null
  }
}

/** Read a stored refresh token, or null when absent/blank. */
export function readRefreshToken(credentialsJson: string): string | null {
  const oauth = parseClaudeOauthBlob(credentialsJson)
  const token = oauth?.refreshToken
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null
}

/**
 * Whether the stored access token is expired or within the refresh buffer.
 *
 * A missing/non-numeric `expiresAt` is treated as "needs refresh" so a blob
 * with no usable expiry metadata still gets a proactive refresh attempt rather
 * than being trusted indefinitely. `now` is injectable for tests.
 */
export function isOauthTokenExpiring(credentialsJson: string, now: number = Date.now()): boolean {
  const oauth = parseClaudeOauthBlob(credentialsJson)
  if (!oauth) {
    return false
  }
  const expiresAt = oauth.expiresAt
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return true
  }
  return now + OAUTH_EXPIRY_BUFFER_MS >= expiresAt
}

/**
 * Merge a token-endpoint response into the stored credentials, returning the
 * updated credentials JSON. Preserves every field the caller already had
 * (including the refresh token when the server does not rotate it) and only
 * overwrites what the response provides. Returns null on malformed input.
 */
export function applyRefreshedToken(
  credentialsJson: string,
  response: TokenEndpointResponse,
  now: number = Date.now()
): string | null {
  let parsed: ClaudeCredentials
  try {
    parsed = JSON.parse(credentialsJson) as ClaudeCredentials
  } catch {
    return null
  }
  const accessToken = response.access_token
  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    return null
  }
  const oauth: ClaudeOauthBlob = { ...parsed.claudeAiOauth }
  oauth.accessToken = accessToken
  if (typeof response.expires_in === 'number' && Number.isFinite(response.expires_in)) {
    oauth.expiresAt = now + response.expires_in * 1000
  }
  // Rotation: keep the existing refresh token unless the server issued a new
  // one. Single-use refresh tokens make persisting the rotated value the whole
  // point of owning refresh.
  if (typeof response.refresh_token === 'string' && response.refresh_token.trim() !== '') {
    oauth.refreshToken = response.refresh_token
  }
  if (typeof response.scope === 'string' && response.scope.trim() !== '') {
    oauth.scopes = response.scope.split(' ')
  }
  parsed.claudeAiOauth = oauth
  return JSON.stringify(parsed)
}

/**
 * Refresh the OAuth token for a stored credentials blob.
 *
 * Returns the updated credentials JSON (with the rotated refresh token and new
 * access token) on success, or null on any failure. Never throws — callers
 * treat null as "keep the existing credentials", so a transient network error
 * is never worse than today's behavior.
 */
export async function refreshClaudeOauthCredentials(
  credentialsJson: string,
  now: number = Date.now()
): Promise<string | null> {
  const refreshToken = readRefreshToken(credentialsJson)
  if (!refreshToken) {
    return null
  }

  await ensureElectronProxyFromEnvironment({
    proxySession: session.defaultSession,
    probeUrl: OAUTH_TOKEN_URL
  }).catch(() => {})

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)
  try {
    // Why: the `claude` CLI posts grant_type=refresh_token as
    // application/x-www-form-urlencoded with the public client id. net.fetch
    // routes through Chromium's stack so the env proxy bridge above applies.
    const res = await net.fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID
      }).toString(),
      signal: controller.signal
    })
    if (!res.ok) {
      // Why: surface the status (never the token) so a throttle (429) or a
      // dead refresh token (400/401 invalid_grant) is diagnosable in the
      // field, instead of a silent null that looks identical to success.
      // Callers keep the existing credentials on null — a transient 429 just
      // means the still-valid token is reused until the next attempt.
      console.warn(`[claude-oauth-refresh] token endpoint returned ${res.status}`)
      return null
    }
    const data = (await res.json()) as TokenEndpointResponse
    return applyRefreshedToken(credentialsJson, data, now)
  } catch (error) {
    console.warn(
      '[claude-oauth-refresh] token refresh request failed:',
      error instanceof Error ? error.message : error
    )
    return null
  } finally {
    clearTimeout(timer)
  }
}
