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
  resolveOwnedClaudeManagedAuthPath
} from '../claude-accounts/managed-auth-path'
import { createOAuthUsageError, OAuthUsageError } from './claude-oauth-usage-error'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA_HEADER = 'oauth-2025-04-20'
const CLAUDE_CODE_USER_AGENT = 'claude-code/2.1.0'
const API_TIMEOUT_MS = 10_000

let proxyConfigured = false

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
  if (proxyConfigured) {
    return
  }
  proxyConfigured = true

  // Why: app.resolveProxy does NOT reflect session-level proxy config —
  // only session.defaultSession.resolveProxy does.
  const resolved = await session.defaultSession.resolveProxy(OAUTH_USAGE_URL)
  if (resolved !== 'DIRECT') {
    return
  }

  const proxyUrl =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy
  if (!proxyUrl) {
    return
  }

  try {
    new URL(proxyUrl)
    await session.defaultSession.setProxy({ proxyRules: proxyUrl })
  } catch {
    // Invalid proxy URL — degrade to direct connection rather than crashing.
    // The usage bar is cosmetic; a typo'd envvar should not break polling.
  }
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
}

// Why: factored out so both the active-account Keychain reader and the
// managed-account reader share the same JSON parsing + refreshability check.
function parseOAuthCredentialsJson(raw: string): OAuthCredentialReadResult {
  try {
    const parsed = JSON.parse(raw) as KeychainCredentials
    const oauth = parsed?.claudeAiOauth
    const token = oauth?.accessToken
    const refreshToken = oauth?.refreshToken
    const hasRefreshableCredentials = typeof refreshToken === 'string' && refreshToken.trim() !== ''
    if (!token || typeof token !== 'string') {
      return {
        token: null,
        hasRefreshableCredentials
      }
    }
    // Why: Claude's local expiresAt metadata is not authoritative for the
    // /api/oauth/usage endpoint. Real Claude Code 2.1 credentials have been
    // observed authenticating there after expiresAt, so let the server decide.
    return {
      token,
      hasRefreshableCredentials
    }
  } catch {
    return emptyOAuthCredentialReadResult()
  }
}

function emptyOAuthCredentialReadResult(): OAuthCredentialReadResult {
  return {
    token: null,
    hasRefreshableCredentials: false
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
    const scopedCredentials = await readCredentialsFromStrictKeychain(configDir)
    if (scopedCredentials.token) {
      return scopedCredentials
    }
    if (scopedCredentials.hasRefreshableCredentials) {
      return scopedCredentials
    }
    const legacyCredentials = await readCredentialsFromStrictKeychain()
    if (legacyCredentials.token) {
      return legacyCredentials
    }
    return scopedCredentials.hasRefreshableCredentials ? scopedCredentials : legacyCredentials
  }

  try {
    const credentials = await readActiveClaudeKeychainCredentials(configDir)
    return credentials ? parseOAuthCredentialsJson(credentials) : emptyOAuthCredentialReadResult()
  } catch {
    return emptyOAuthCredentialReadResult()
  }
}

async function readCredentialsFromStrictKeychain(
  configDir?: string
): Promise<OAuthCredentialReadResult> {
  try {
    const credentials = await readActiveClaudeKeychainCredentialsStrict(configDir)
    return credentials ? parseOAuthCredentialsJson(credentials) : emptyOAuthCredentialReadResult()
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
    return parseOAuthCredentialsJson(raw)
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
async function readOAuthCredentials(configDir?: string): Promise<OAuthCredentialReadResult> {
  // 1. macOS Keychain (Claude Max/Pro OAuth)
  const fromKeychain = await readFromKeychain(configDir)
  if (fromKeychain.token) {
    return fromKeychain
  }
  if (fromKeychain.hasRefreshableCredentials) {
    return fromKeychain
  }

  // 2. Legacy credentials file
  const fromFile = await readFromCredentialsFile(configDir)
  if (fromFile.token) {
    return fromFile
  }
  if (fromFile.hasRefreshableCredentials) {
    return fromFile
  }

  return emptyOAuthCredentialReadResult()
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

export async function fetchClaudeRateLimits(options?: {
  authPreparation?: ClaudeRuntimeAuthPreparation
}): Promise<ProviderRateLimits> {
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
  const oauthCredentials = await readOAuthCredentials(options?.authPreparation?.configDir)
  if (oauthCredentials.token) {
    try {
      return await fetchViaOAuth(oauthCredentials.token)
    } catch (err) {
      if (err instanceof OAuthUsageError && err.skipPtyFallback) {
        return {
          provider: 'claude',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: withMacTailscaleDnsHint(err.message),
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
    try {
      return await fetchViaPty({ authPreparation: options?.authPreparation })
    } catch (err) {
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

// Why: reads an inactive account's OAuth token directly from its managed
// storage without materializing credentials into the shared runtime location.
// Using ClaudeRuntimeAuthService would overwrite the active account's auth.
async function readManagedOAuthToken(account: InactiveClaudeAccountInfo): Promise<string | null> {
  try {
    if (account.managedAuthRuntime === 'wsl') {
      const managedAuthPath = resolveOwnedWslClaudeManagedAuthPath(account)
      if (!managedAuthPath) {
        return null
      }
      const raw = readClaudeManagedAuthFile(managedAuthPath, '.credentials.json')
      return raw ? parseOAuthCredentialsJson(raw).token : null
    }
    const managedAuthPath = resolveOwnedClaudeManagedAuthPath(account.id, account.managedAuthPath, {
      adoptLegacyMarker: true
    })
    if (!managedAuthPath) {
      return null
    }
    if (process.platform === 'darwin') {
      const raw = await readManagedClaudeKeychainCredentials(account.id)
      if (raw) {
        return parseOAuthCredentialsJson(raw).token
      }
      return null
    }
    const raw = readClaudeManagedAuthFile(managedAuthPath, '.credentials.json')
    return raw ? parseOAuthCredentialsJson(raw).token : null
  } catch {
    return null
  }
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
  const token = await readManagedOAuthToken(account)
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
