/* eslint-disable max-lines -- Why: this module keeps Claude credential source
ordering, OAuth usage fetch semantics, and PTY fallback behavior together so
subscription usage state cannot drift across code paths. */
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { net, session } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { fetchViaPty } from './claude-pty'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import {
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict,
  readManagedClaudeKeychainCredentials
} from '../claude-accounts/keychain'
import {
  readClaudeManagedAuthFile,
  resolveOwnedClaudeManagedAuthPath,
  writeClaudeManagedAuthFile
} from '../claude-accounts/managed-auth-path'
import { writeManagedClaudeKeychainCredentials } from '../claude-accounts/keychain'
import {
  isOauthTokenExpiring,
  refreshClaudeOauthCredentials
} from '../claude-accounts/oauth-refresh'
import { createOAuthUsageError, OAuthUsageError } from './claude-oauth-usage-error'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA_HEADER = 'oauth-2025-04-20'
const CLAUDE_CODE_USER_AGENT = 'claude-code/2.1.0'
const API_TIMEOUT_MS = 10_000
const LIVE_CLAUDE_REFRESH_DEFERRED_MESSAGE =
  'Claude usage refresh is waiting for the live Claude terminal to rotate its credentials.'

/**
 * Bridge standard HTTP proxy env vars into Electron's session proxy config.
 *
 * Why: Electron's net.fetch uses Chromium's networking stack which respects
 * OS-level proxy settings but ignores HTTP_PROXY / HTTPS_PROXY env vars.
 * Users in regions where api.anthropic.com is only reachable via proxy (see
 * #521, #800) often set these env vars rather than configuring system proxy.
 * Without this bridge, the usage indicator silently fails and the app may hit
 * Anthropic from an unexpected IP, risking rate-limit signals on the account.
 */
async function ensureProxyFromEnv(): Promise<void> {
  await ensureElectronProxyFromEnvironment({
    proxySession: session.defaultSession,
    probeUrl: OAUTH_USAGE_URL
  }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Credential reading — tries multiple sources for an OAuth bearer token
// ---------------------------------------------------------------------------

type KeychainCredentials = {
  claudeAiOauth?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
  }
}

type OAuthCredentialReadResult = {
  token: string | null
  hasRefreshableCredentials: boolean
  source: OAuthCredentialSource
}

type OAuthCredentialReadOptions = {
  credentialsFileConfigDir?: string
  keychainConfigDir?: string
}

type OAuthCredentialSource = 'scoped-keychain' | 'legacy-keychain' | 'credentials-file' | 'none'

// Why: factored out so both the active-account Keychain reader and the
// managed-account reader share the same JSON parsing + refreshability check.
function parseOAuthCredentialsJson(
  raw: string,
  source: OAuthCredentialSource
): OAuthCredentialReadResult {
  try {
    const parsed = JSON.parse(raw) as KeychainCredentials
    const oauth = parsed?.claudeAiOauth
    const token = oauth?.accessToken
    const refreshToken = oauth?.refreshToken
    const hasRefreshableCredentials = typeof refreshToken === 'string' && refreshToken.trim() !== ''
    if (!token || typeof token !== 'string') {
      return {
        token: null,
        hasRefreshableCredentials,
        source
      }
    }
    // Why: Claude's local expiresAt metadata is not authoritative for the
    // /api/oauth/usage endpoint. Real Claude Code 2.1 credentials have been
    // observed authenticating there after expiresAt, so let the server decide.
    return {
      token,
      hasRefreshableCredentials,
      source
    }
  } catch {
    return emptyOAuthCredentialReadResult()
  }
}

function emptyOAuthCredentialReadResult(): OAuthCredentialReadResult {
  return {
    token: null,
    hasRefreshableCredentials: false,
    source: 'none'
  }
}

/**
 * Read OAuth token from macOS Keychain.
 * Why: Claude Code 2.1+ scopes OAuth Keychain services by CLAUDE_CONFIG_DIR;
 * older builds used the legacy unsuffixed service. The shared reader handles both.
 */
async function readFromKeychain(configDir?: string): Promise<OAuthCredentialReadResult> {
  if (process.platform !== 'darwin') {
    return emptyOAuthCredentialReadResult()
  }

  if (configDir) {
    const scopedCredentials = await readCredentialsFromStrictKeychain(configDir, 'scoped-keychain')
    if (scopedCredentials.token) {
      return scopedCredentials
    }
    if (scopedCredentials.hasRefreshableCredentials) {
      return scopedCredentials
    }
    const legacyCredentials = await readCredentialsFromStrictKeychain(undefined, 'legacy-keychain')
    if (legacyCredentials.token) {
      return legacyCredentials
    }
    return scopedCredentials.hasRefreshableCredentials ? scopedCredentials : legacyCredentials
  }

  try {
    const credentials = await readActiveClaudeKeychainCredentials(configDir)
    return credentials
      ? parseOAuthCredentialsJson(credentials, 'legacy-keychain')
      : emptyOAuthCredentialReadResult()
  } catch {
    return emptyOAuthCredentialReadResult()
  }
}

async function readCredentialsFromStrictKeychain(
  configDir: string | undefined,
  source: OAuthCredentialSource
): Promise<OAuthCredentialReadResult> {
  try {
    const credentials = await readActiveClaudeKeychainCredentialsStrict(configDir)
    return credentials
      ? parseOAuthCredentialsJson(credentials, source)
      : emptyOAuthCredentialReadResult()
  } catch {
    return emptyOAuthCredentialReadResult()
  }
}

/**
 * Read OAuth token from ~/.claude/.credentials.json (legacy path).
 * Why: older Claude CLI versions store credentials in this plain JSON
 * file. We keep it as a fallback for compatibility.
 */
async function readFromCredentialsFile(configDir?: string): Promise<OAuthCredentialReadResult> {
  const credPath = path.join(configDir ?? path.join(homedir(), '.claude'), '.credentials.json')
  try {
    const raw = await readFile(credPath, 'utf-8')
    return parseOAuthCredentialsJson(raw, 'credentials-file')
  } catch {
    return emptyOAuthCredentialReadResult()
  }
}

/**
 * Try credential sources that yield a genuine OAuth bearer token.
 * Why: we intentionally do NOT read ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY
 * here — those are API keys which return 401 on the OAuth usage endpoint.
 * API-key users are served by the PTY fallback instead.
 */
async function readOAuthCredentials(
  options?: OAuthCredentialReadOptions
): Promise<OAuthCredentialReadResult> {
  // 1. macOS Keychain (Claude Max/Pro OAuth)
  const fromKeychain = await readFromKeychain(options?.keychainConfigDir)
  if (fromKeychain.token) {
    return fromKeychain
  }
  if (fromKeychain.hasRefreshableCredentials) {
    return fromKeychain
  }

  // 2. Legacy credentials file
  const fromFile = await readFromCredentialsFile(options?.credentialsFileConfigDir)
  if (fromFile.token) {
    return fromFile
  }
  if (fromFile.hasRefreshableCredentials) {
    return fromFile
  }

  return emptyOAuthCredentialReadResult()
}

function resolveOAuthCredentialReadOptions(
  authPreparation?: ClaudeRuntimeAuthPreparation
): OAuthCredentialReadOptions | undefined {
  if (!authPreparation) {
    return undefined
  }
  const readOptions: OAuthCredentialReadOptions = {
    credentialsFileConfigDir: authPreparation.configDir
  }
  // Why: host system-default launches do not inject CLAUDE_CONFIG_DIR, so
  // their Keychain lookup must mirror Claude's legacy service ordering.
  if (authPreparation.envPatch.CLAUDE_CONFIG_DIR) {
    readOptions.keychainConfigDir = authPreparation.configDir
  }
  return readOptions
}

function buildClaudeUsageFetchDiagnostic(
  authPreparation: ClaudeRuntimeAuthPreparation | undefined,
  oauthCredentials: OAuthCredentialReadResult
): Record<string, unknown> {
  return {
    provenance: authPreparation?.provenance ?? 'system',
    runtime: authPreparation?.runtime ?? 'host',
    wslDistro: authPreparation?.wslDistro ?? null,
    hasExplicitClaudeConfigDir: Boolean(authPreparation?.envPatch.CLAUDE_CONFIG_DIR),
    credentialSource: oauthCredentials.source,
    hasRefreshableCredentials: oauthCredentials.hasRefreshableCredentials
  }
}

function warnClaudeUsageFetchFailure(
  authPreparation: ClaudeRuntimeAuthPreparation | undefined,
  oauthCredentials: OAuthCredentialReadResult,
  error: unknown
): void {
  const message = error instanceof Error ? error.message : String(error)
  const status = error instanceof OAuthUsageError ? error.status : null
  console.warn('[claude-rate-limits] Claude usage refresh failed', {
    ...buildClaudeUsageFetchDiagnostic(authPreparation, oauthCredentials),
    status,
    message
  })
}

// ---------------------------------------------------------------------------
// OAuth API fetch
// ---------------------------------------------------------------------------

type OAuthUsageWindow = {
  utilization?: number
  resets_at?: string
}

type OAuthUsageResponse = {
  five_hour?: OAuthUsageWindow
  seven_day?: OAuthUsageWindow
}

function parseResetDescription(isoString: string | undefined): string | null {
  if (!isoString) {
    return null
  }
  try {
    const date = new Date(isoString)
    if (isNaN(date.getTime())) {
      return null
    }
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()
    if (isToday) {
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    }
    return date.toLocaleDateString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit'
    })
  } catch {
    return null
  }
}

function mapWindow(
  raw: OAuthUsageWindow | undefined,
  windowMinutes: number
): RateLimitWindow | null {
  if (!raw || typeof raw.utilization !== 'number') {
    return null
  }
  return {
    usedPercent: Math.min(100, Math.max(0, raw.utilization)),
    windowMinutes,
    resetsAt: raw.resets_at ? new Date(raw.resets_at).getTime() || null : null,
    resetDescription: parseResetDescription(raw.resets_at)
  }
}

async function fetchViaOAuth(token: string): Promise<ProviderRateLimits> {
  await ensureProxyFromEnv()

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

  try {
    // Why: net.fetch uses Chromium's networking stack which respects OS proxy
    // settings and certificates. Env var proxies are bridged by ensureProxyFromEnv.
    const res = await net.fetch(OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        // Why: Claude's OAuth usage endpoint is the Claude Code usage API;
        // matching the CLI user-agent keeps Orca aligned with that contract.
        'User-Agent': CLAUDE_CODE_USER_AGENT
      },
      signal: controller.signal
    })

    if (!res.ok) {
      throw await createOAuthUsageError(res)
    }

    const data = (await res.json()) as OAuthUsageResponse

    return {
      provider: 'claude',
      session: mapWindow(data.five_hour, 300),
      weekly: mapWindow(data.seven_day, 10080),
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type FetchClaudeRateLimitsOptions = {
  authPreparation?: ClaudeRuntimeAuthPreparation
  allowPtyFallback?: boolean
}

export async function fetchClaudeRateLimits(
  options?: FetchClaudeRateLimitsOptions
): Promise<ProviderRateLimits> {
  if (options?.authPreparation?.runtime === 'wsl' && !options.authPreparation.wslLinuxConfigDir) {
    return {
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: `WSL Claude config unavailable for ${options.authPreparation.wslDistro ?? 'default distro'}`,
      status: 'error'
    }
  }

  // Path A: try OAuth API if we have a genuine OAuth token
  const oauthCredentials = await readOAuthCredentials(
    resolveOAuthCredentialReadOptions(options?.authPreparation)
  )
  if (oauthCredentials.token) {
    try {
      return await fetchViaOAuth(oauthCredentials.token)
    } catch (err) {
      warnClaudeUsageFetchFailure(options?.authPreparation, oauthCredentials, err)
      if (
        options?.authPreparation?.managedRefreshDeferredByLivePty &&
        err instanceof OAuthUsageError &&
        (err.status === 401 || err.status === 403)
      ) {
        return {
          provider: 'claude',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: LIVE_CLAUDE_REFRESH_DEFERRED_MESSAGE,
          status: 'error'
        }
      }
      if (
        options?.allowPtyFallback === false ||
        (err instanceof OAuthUsageError && err.skipPtyFallback)
      ) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        return {
          provider: 'claude',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: withMacTailscaleDnsHint(message),
          status: 'error'
        }
      }
      // OAuth API failed — fall through to PTY scraping as a backup
      // for subscription users whose token may still be valid for the CLI.
    }
  }

  // Path B: PTY fallback — only for subscription plan users (Max/Pro)
  // whose OAuth credentials exist. This remains a fallback for older Claude
  // auth shapes and transient OAuth failures.
  if (oauthCredentials.token || oauthCredentials.hasRefreshableCredentials) {
    if (options?.allowPtyFallback === false) {
      return {
        provider: 'claude',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: options?.authPreparation?.managedRefreshDeferredByLivePty
          ? LIVE_CLAUDE_REFRESH_DEFERRED_MESSAGE
          : 'Claude OAuth access token unavailable',
        status: 'error'
      }
    }
    try {
      return await fetchViaPty({ authPreparation: options?.authPreparation })
    } catch (err) {
      warnClaudeUsageFetchFailure(options?.authPreparation, oauthCredentials, err)
      const message = err instanceof Error ? err.message : 'Unknown error'
      return {
        provider: 'claude',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: withMacTailscaleDnsHint(message),
        status: 'error'
      }
    }
  }

  // No OAuth token found — user authenticates via API key.
  // Why: plan usage limits (session/weekly) only exist for Claude Max/Pro
  // subscription plans. API key users are billed per-token and don't have
  // rate limit windows to display.
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'No subscription plan — API key billing',
    status: 'unavailable'
  }
}

// ---------------------------------------------------------------------------
// Managed account usage (inactive accounts — fetch-on-open)
// ---------------------------------------------------------------------------

export type InactiveClaudeAccountInfo = {
  id: string
  managedAuthPath: string
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxAuthPath?: string | null
}

type ManagedCredentialsLocation =
  | { kind: 'keychain'; accountId: string }
  | { kind: 'file'; managedAuthPath: string }

// Why: resolves where an inactive account's credentials live without
// materializing them into the shared runtime location. Using
// ClaudeRuntimeAuthService would overwrite the active account's auth.
function resolveManagedCredentialsLocation(
  account: InactiveClaudeAccountInfo
): ManagedCredentialsLocation | null {
  if (account.managedAuthRuntime === 'wsl') {
    const managedAuthPath = resolveOwnedWslClaudeManagedAuthPath(account)
    return managedAuthPath ? { kind: 'file', managedAuthPath } : null
  }
  const managedAuthPath = resolveOwnedClaudeManagedAuthPath(account.id, account.managedAuthPath, {
    adoptLegacyMarker: true
  })
  if (!managedAuthPath) {
    return null
  }
  // macOS stores host managed credentials in the Keychain; everything else
  // (and WSL, handled above) stores them as a file under the managed dir.
  if (process.platform === 'darwin') {
    return { kind: 'keychain', accountId: account.id }
  }
  return { kind: 'file', managedAuthPath }
}

async function readManagedCredentialsJson(
  location: ManagedCredentialsLocation
): Promise<string | null> {
  try {
    if (location.kind === 'keychain') {
      return await readManagedClaudeKeychainCredentials(location.accountId)
    }
    return readClaudeManagedAuthFile(location.managedAuthPath, '.credentials.json')
  } catch {
    return null
  }
}

async function writeManagedCredentialsJson(
  location: ManagedCredentialsLocation,
  credentialsJson: string
): Promise<void> {
  if (location.kind === 'keychain') {
    await writeManagedClaudeKeychainCredentials(location.accountId, credentialsJson)
    return
  }
  writeClaudeManagedAuthFile(location.managedAuthPath, '.credentials.json', credentialsJson)
}

function resolveOwnedWslClaudeManagedAuthPath(account: InactiveClaudeAccountInfo): string | null {
  if (process.platform !== 'win32') {
    return null
  }
  const wslInfo = parseWslUncPath(account.managedAuthPath)
  if (!wslInfo || (account.wslDistro && wslInfo.distro !== account.wslDistro)) {
    return null
  }
  const linuxPath = account.wslLinuxAuthPath ?? wslInfo.linuxPath
  if (
    !linuxPath.includes('/.local/share/orca/claude-accounts/') ||
    !linuxPath.endsWith(`/${account.id}/auth`)
  ) {
    return null
  }
  try {
    const markerPath = path.join(account.managedAuthPath, '.orca-managed-claude-auth')
    if (
      !existsSync(markerPath) ||
      lstatSync(markerPath).isSymbolicLink() ||
      readFileSync(markerPath, 'utf-8').trim() !== account.id
    ) {
      return null
    }
    return account.managedAuthPath
  } catch {
    return null
  }
}

export async function fetchManagedAccountUsage(
  account: InactiveClaudeAccountInfo
): Promise<ProviderRateLimits> {
  const location = resolveManagedCredentialsLocation(account)
  const credentialsJson = location ? await readManagedCredentialsJson(location) : null
  if (!credentialsJson) {
    return {
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'No credentials',
      status: 'error'
    }
  }

  // Why: own the refresh for inactive accounts (claude-swap's model) — when the
  // stored token is expiring, refresh and persist the rotated token back to
  // managed storage before fetching usage. This keeps inactive accounts'
  // single-use refresh tokens fresh so a later switch-in never materializes a
  // stale token. Persistence failure is non-fatal: we still try the fetch.
  let token = parseOAuthCredentialsJson(credentialsJson, 'credentials-file').token
  if (location && isOauthTokenExpiring(credentialsJson)) {
    const refreshed = await refreshClaudeOauthCredentials(credentialsJson)
    if (refreshed) {
      try {
        await writeManagedCredentialsJson(location, refreshed)
      } catch {
        // Keep going with the refreshed token in memory even if the write
        // failed; worst case the next poll refreshes again.
      }
      token = parseOAuthCredentialsJson(refreshed, 'credentials-file').token
    }
  }

  if (!token) {
    return {
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'No credentials',
      status: 'error'
    }
  }

  // Why: PTY fallback is intentionally omitted for inactive accounts. The PTY
  // path materializes credentials via ClaudeRuntimeAuthService, which would
  // interfere with the active account's auth state.
  return fetchViaOAuth(token)
}
