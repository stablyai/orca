import { EnvHttpProxyAgent, fetch as nodeFetch, type Dispatcher } from 'undici'
import {
  buildConfiguredProxyEnv,
  getProxyUrlFromEnvironment,
  type NetworkProxySettings
} from '../../shared/network-proxy'

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

/** Whether the stored access token is already past its expiry (no refresh buffer). */
export function isOauthTokenExpired(credentialsJson: string, now: number = Date.now()): boolean {
  const expiresAt = parseClaudeOauthBlob(credentialsJson)?.expiresAt
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && now >= expiresAt
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

export type ClaudeOauthRefreshOptions = {
  networkProxySettings?: NetworkProxySettings | null
  env?: Record<string, string | undefined>
  now?: number
  /** Caller cancellation; the request also carries its own timeout. */
  signal?: AbortSignal
}

const NODE_PROXY_PROTOCOLS = new Set(['http:', 'https:'])

type RefreshRoute =
  | { kind: 'direct' }
  | { kind: 'proxy'; dispatcher: Dispatcher }
  /** A proxy is configured but undici cannot tunnel through it; never bypass it. */
  | { kind: 'unsupported-proxy'; protocol: string }

/**
 * Proxy for the token request, resolved the way child processes get theirs:
 * Orca's configured proxy wins over the shell's, and its bypass list replaces
 * NO_PROXY.
 */
function resolveRefreshRoute(
  settings: NetworkProxySettings | null | undefined,
  env: Record<string, string | undefined>
): RefreshRoute {
  const merged = { ...env, ...buildConfiguredProxyEnv(settings) }
  const proxy = getProxyUrlFromEnvironment(merged)
  if (!proxy.ok || !proxy.value) {
    return { kind: 'direct' }
  }
  const protocol = new URL(proxy.value).protocol
  if (!NODE_PROXY_PROTOCOLS.has(protocol)) {
    return { kind: 'unsupported-proxy', protocol }
  }
  return {
    kind: 'proxy',
    dispatcher: new EnvHttpProxyAgent({
      httpProxy: proxy.value,
      httpsProxy: proxy.value,
      noProxy: merged.NO_PROXY ?? merged.no_proxy ?? ''
    })
  }
}

export type ClaudeOauthRefreshFailure =
  | 'no-refresh-token'
  /** The server no longer accepts the refresh token: only a fresh login recovers the account. */
  | 'invalid-grant'
  | 'rate-limited'
  | 'rejected'
  | 'network'
  /** A SOCKS proxy is configured; the request was not sent rather than bypass it. */
  | 'unsupported-proxy'

export type ClaudeOauthRefreshOutcome =
  | { credentialsJson: string; failure?: undefined }
  | { credentialsJson: null; failure: ClaudeOauthRefreshFailure }

async function classifyRefreshRejection(res: {
  status: number
  json(): Promise<unknown>
}): Promise<ClaudeOauthRefreshFailure> {
  if (res.status === 429) {
    return 'rate-limited'
  }
  // Why: RFC 6749 puts the reason in the body; a dead refresh token is 400 invalid_grant.
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  return body?.error === 'invalid_grant' ? 'invalid-grant' : 'rejected'
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
  options: ClaudeOauthRefreshOptions = {}
): Promise<string | null> {
  return (await refreshClaudeOauthCredentialsWithOutcome(credentialsJson, options)).credentialsJson
}

/** Same as refreshClaudeOauthCredentials, but says why a refresh failed. */
export async function refreshClaudeOauthCredentialsWithOutcome(
  credentialsJson: string,
  options: ClaudeOauthRefreshOptions = {}
): Promise<ClaudeOauthRefreshOutcome> {
  const refreshToken = readRefreshToken(credentialsJson)
  if (!refreshToken) {
    return { credentialsJson: null, failure: 'no-refresh-token' }
  }

  // Why: the token endpoint answers 429 to Chromium's network stack (Electron
  // net.fetch) while the same request from Node succeeds (orca#18716), so the
  // refresh goes through Node's stack like the `claude` CLI's own refresh.
  const route = resolveRefreshRoute(options.networkProxySettings, options.env ?? process.env)
  if (route.kind === 'unsupported-proxy') {
    // Why: connecting directly would leave the configured egress route; keeping the old token is the safer failure.
    console.warn(
      `[claude-oauth-refresh] ${route.protocol} proxies are not supported for token refresh; skipping`
    )
    return { credentialsJson: null, failure: 'unsupported-proxy' }
  }
  const dispatcher = route.kind === 'proxy' ? route.dispatcher : undefined
  try {
    // Why: the `claude` CLI posts grant_type=refresh_token as
    // application/x-www-form-urlencoded with the public client id.
    const res = await nodeFetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID
      }).toString(),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(REFRESH_TIMEOUT_MS)])
        : AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      ...(dispatcher ? { dispatcher } : {})
    })
    if (!res.ok) {
      // Why: surface the status (never the token) so a throttle (429) or a
      // dead refresh token (400/401 invalid_grant) is diagnosable in the
      // field, instead of a silent null that looks identical to success.
      // Callers keep the existing credentials on null — a transient 429 just
      // means the still-valid token is reused until the next attempt.
      console.warn(`[claude-oauth-refresh] token endpoint returned ${res.status}`)
      const failure = await classifyRefreshRejection(res)
      // Why: an unread undici body can crash the process (orca#8695).
      await res.body?.cancel().catch(() => {})
      return { credentialsJson: null, failure }
    }
    const data = (await res.json()) as TokenEndpointResponse
    const refreshed = applyRefreshedToken(credentialsJson, data, options.now ?? Date.now())
    return refreshed
      ? { credentialsJson: refreshed }
      : { credentialsJson: null, failure: 'rejected' }
  } catch (error) {
    // Why: undici reports every transport failure as "fetch failed"; the cause carries the real error.
    console.warn(
      '[claude-oauth-refresh] token refresh request failed:',
      error instanceof Error ? error.message : error,
      error instanceof Error && error.cause instanceof Error ? error.cause.message : ''
    )
    return { credentialsJson: null, failure: 'network' }
  } finally {
    await dispatcher?.close().catch(() => {})
  }
}
