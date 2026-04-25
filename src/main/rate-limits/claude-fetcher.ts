import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { net, session } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { fetchViaPty } from './claude-pty'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA_HEADER = 'oauth-2025-04-20'
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

type ClaudeCredentials = {
  claudeAiOauth?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number // unix ms
  }
}

type KeychainCredentials = {
  claudeAiOauth?: {
    accessToken?: string
    expiresAt?: number
  }
}

/**
 * Read OAuth token from macOS Keychain.
 * Why: Claude Code v2.x+ stores OAuth credentials in the macOS Keychain
 * under service "Claude Code-credentials". This is the standard location
 * for Claude Max/Pro OAuth tokens. Only returns a token if the keychain
 * entry has a `claudeAiOauth.accessToken` — API key users won't have this.
 */
async function readFromKeychain(): Promise<string | null> {
  if (process.platform !== 'darwin') {
    return null
  }

  return new Promise<string | null>((resolve) => {
    const user = process.env.USER ?? ''
    if (!user) {
      resolve(null)
      return
    }

    execFile(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-a', user, '-w'],
      { timeout: 3_000 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null)
          return
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as KeychainCredentials
          const token = parsed?.claudeAiOauth?.accessToken
          if (!token || typeof token !== 'string') {
            resolve(null)
            return
          }

          const expiresAt = parsed.claudeAiOauth?.expiresAt
          if (typeof expiresAt === 'number' && expiresAt < Date.now()) {
            resolve(null)
            return
          }

          resolve(token)
        } catch {
          resolve(null)
        }
      }
    )
  })
}

/**
 * Read OAuth token from ~/.claude/.credentials.json (legacy path).
 * Why: older Claude CLI versions store credentials in this plain JSON
 * file. We keep it as a fallback for compatibility.
 */
async function readFromCredentialsFile(configDir?: string): Promise<string | null> {
  const credPath = path.join(configDir ?? path.join(homedir(), '.claude'), '.credentials.json')
  try {
    const raw = await readFile(credPath, 'utf-8')
    const parsed = JSON.parse(raw) as ClaudeCredentials
    const token = parsed?.claudeAiOauth?.accessToken
    if (!token || typeof token !== 'string') {
      return null
    }

    const expiresAt = parsed.claudeAiOauth?.expiresAt
    if (typeof expiresAt === 'number' && expiresAt < Date.now()) {
      return null
    }

    return token
  } catch {
    return null
  }
}

/**
 * Try credential sources that yield a genuine OAuth bearer token.
 * Why: we intentionally do NOT read ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY
 * here — those are API keys which return 401 on the OAuth usage endpoint.
 * API-key users are served by the PTY fallback instead.
 */
async function readOAuthCredentials(configDir?: string): Promise<string | null> {
  // 1. macOS Keychain (Claude Max/Pro OAuth)
  const fromKeychain = await readFromKeychain()
  if (fromKeychain) {
    return fromKeychain
  }

  // 2. Legacy credentials file
  const fromFile = await readFromCredentialsFile(configDir)
  if (fromFile) {
    return fromFile
  }

  return null
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
        'anthropic-beta': OAUTH_BETA_HEADER
      },
      signal: controller.signal
    })

    if (!res.ok) {
      throw new Error(`OAuth API returned ${res.status}`)
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
  // Path A: try OAuth API if we have a genuine OAuth token
  const oauthToken = await readOAuthCredentials(
    options?.authPreparation?.envPatch.CLAUDE_CONFIG_DIR
  )
  if (oauthToken) {
    try {
      return await fetchViaOAuth(oauthToken)
    } catch {
      // OAuth API failed — fall through to PTY scraping as a backup
      // for subscription users whose token may still be valid for the CLI.
    }

    // Path B: PTY fallback — only for subscription plan users (Max/Pro)
    // whose OAuth token we found but the API call failed. The CLI's
    // `/usage` command is subscription-only, so there's no point
    // attempting PTY for API key users.
    try {
      return await fetchViaPty({ authPreparation: options?.authPreparation })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return {
        provider: 'claude',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: message,
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
