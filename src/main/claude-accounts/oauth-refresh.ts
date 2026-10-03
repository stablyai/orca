import { net, session } from 'electron'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'

// Why: the OAuth client id and token endpoint are the public Claude Code
// values. The refresh body matches `claude` 2.1.286 (`Pde`): JSON, the public
// client id, and the prod scope list. A form body without scopes no longer
// matches the CLI, so an inactive account's still-valid refresh token never
// became a usage window.
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

// Prod Claude Code 2.1.286 (`yJe` with PLUGINS_SCOPE_REGISTERED). Project
// scopes are re-requested only when the stored blob already has them (`N5r`).
const CLAUDE_CODE_REFRESH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
  'user:plugins'
]
const CLAUDE_CODE_PROJECT_SCOPES = ['user:projects:read', 'user:projects:write']

// Refresh slightly ahead of expiry so a token doesn't expire mid-launch. The
// CLI uses the same 5-minute skew for its own refresh decision.
const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000
const REFRESH_TIMEOUT_MS = 30_000

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

/** Read a stored access token, or null when absent/blank. */
export function readAccessToken(credentialsJson: string): string | null {
  const oauth = parseClaudeOauthBlob(credentialsJson)
  const token = oauth?.accessToken
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

function storedScopeList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim())
}

function uniqueScopes(scopes: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const scope of scopes) {
    if (seen.has(scope)) {
      continue
    }
    seen.add(scope)
    unique.push(scope)
  }
  return unique
}

function claudeCodeRefreshPlan(credentialsJson: string): {
  refreshToken: string
  clientId: string
  scopes: string[] | null
  storedScopeFallback: string[] | null
} | null {
  const refreshToken = readRefreshToken(credentialsJson)
  if (!refreshToken) {
    return null
  }
  const oauth = parseClaudeOauthBlob(credentialsJson)
  const storedScopes = storedScopeList(oauth?.scopes)
  const rawClientId = oauth?.clientId
  const storedClientId =
    typeof rawClientId === 'string' && rawClientId.trim() !== '' ? rawClientId.trim() : null
  const subscriptionType = oauth?.subscriptionType
  const hasSubscription = typeof subscriptionType === 'string' && subscriptionType.trim() !== ''
  const hasInference = storedScopes.includes('user:inference')
  // Why: Claude Code expands to its prod scope list only for a first-party
  // login (no stored client id) that already has inference or a subscription.
  // A third-party client id keeps the scopes that client was granted.
  const expand = storedClientId === null && (hasInference || hasSubscription)
  const expanded = uniqueScopes([
    ...CLAUDE_CODE_REFRESH_SCOPES,
    ...CLAUDE_CODE_PROJECT_SCOPES.filter((scope) => storedScopes.includes(scope))
  ])
  // Why: a third-party client with no stored scopes must not be handed the first-party list.
  // Omitting scope asks the server to keep the grant that client already has.
  const scopes: string[] | null = expand
    ? expanded
    : storedScopes.length > 0
      ? storedScopes
      : storedClientId
        ? null
        : [...CLAUDE_CODE_REFRESH_SCOPES]
  const requested = scopes ?? []
  const storedScopeFallback =
    expand && storedScopes.length > 0 && storedScopes.join(' ') !== requested.join(' ')
      ? storedScopes
      : null
  return {
    refreshToken,
    clientId: storedClientId ?? OAUTH_CLIENT_ID,
    scopes,
    storedScopeFallback
  }
}

type RefreshPostResult =
  | { ok: true; data: TokenEndpointResponse }
  | { ok: false; status: number; errorCode: string | null }

function oauthErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null
  }
  const error = (body as { error?: unknown }).error
  if (typeof error === 'string' && error.trim() !== '') {
    return error
  }
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { type?: unknown }).type === 'string'
  ) {
    const type = (error as { type: string }).type.trim()
    return type !== '' ? type : null
  }
  return null
}

async function postClaudeRefreshGrant(input: {
  refreshToken: string
  clientId: string
  scopes: string[] | null
}): Promise<RefreshPostResult> {
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId
  }
  if (input.scopes && input.scopes.length > 0) {
    body.scope = input.scopes.join(' ')
  }
  const res = await net.fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS)
  })
  if (res.ok) {
    return { ok: true, data: (await res.json()) as TokenEndpointResponse }
  }
  let errorCode: string | null = null
  try {
    errorCode = oauthErrorCode(await res.json())
  } catch {
    errorCode = null
  }
  return { ok: false, status: res.status, errorCode }
}

function warnRefreshRejection(status: number, errorCode: string | null): void {
  // Why: status and error code only. The body can echo the refresh token.
  console.warn(
    `[claude-oauth-refresh] token endpoint returned ${status}${errorCode ? ` ${errorCode}` : ''}`
  )
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
  const plan = claudeCodeRefreshPlan(credentialsJson)
  if (!plan) {
    return null
  }

  await ensureElectronProxyFromEnvironment({
    proxySession: session.defaultSession,
    probeUrl: OAUTH_TOKEN_URL
  }).catch(() => {})

  try {
    // Why: net.fetch routes through Chromium's stack so the env proxy bridge
    // above applies. The body matches Claude Code 2.1.286, which posts JSON.
    let result = await postClaudeRefreshGrant(plan)
    if (
      !result.ok &&
      result.status === 400 &&
      result.errorCode === 'invalid_scope' &&
      plan.storedScopeFallback
    ) {
      warnRefreshRejection(result.status, result.errorCode)
      result = await postClaudeRefreshGrant({
        refreshToken: plan.refreshToken,
        clientId: plan.clientId,
        scopes: plan.storedScopeFallback
      })
    }
    if (!result.ok) {
      warnRefreshRejection(result.status, result.errorCode)
      return null
    }
    return applyRefreshedToken(credentialsJson, result.data, now)
  } catch (error) {
    console.warn(
      '[claude-oauth-refresh] token refresh request failed:',
      error instanceof Error ? error.message : error
    )
    return null
  }
}
