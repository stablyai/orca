import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { net } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

// Why: GitHub's Copilot token exchange endpoint is shared by every Copilot
// client (CLI, Chat, Neovim) — see IEntitlementsData/IQuotaSnapshotData in
// microsoft/vscode's defaultAccount.ts for the authoritative response shape.
const TOKEN_EXCHANGE_URL = 'https://api.github.com/copilot_internal/v2/token'
const API_TIMEOUT_MS = 10_000
const KEYCHAIN_SERVICE = 'copilot-cli'
const KEYCHAIN_COMMAND_TIMEOUT_MS = 3_000
const MONTHLY_WINDOW_MINUTES = 30 * 24 * 60 // 30d

const OAUTH_TOKEN_KEYS = ['oauth_token', 'oauthToken', 'token', 'access_token', 'accessToken']

type CredentialsReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; token: string }

function getConfigHome(): string {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  }
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
}

function getCredentialsFilePaths(): string[] {
  const base = join(getConfigHome(), 'github-copilot')
  return [join(base, 'hosts.json'), join(base, 'apps.json')]
}

function extractOAuthToken(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  for (const key of OAUTH_TOKEN_KEYS) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  for (const nested of Object.values(record)) {
    if (typeof nested === 'object' && nested !== null) {
      const found = extractOAuthToken(nested)
      if (found) {
        return found
      }
    }
  }
  return null
}

function readTokenFromConfigFiles(): CredentialsReadResult {
  const paths = getCredentialsFilePaths().filter((path) => existsSync(path))
  if (paths.length === 0) {
    return { status: 'missing' }
  }
  for (const path of paths) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      const token = extractOAuthToken(parsed)
      if (token) {
        return { status: 'ok', token }
      }
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : `Unable to read ${path}`
      }
    }
  }
  return { status: 'missing' }
}

/**
 * Why read-only: the Copilot CLI owns this Keychain entry and its lifecycle.
 * Orca must never write, refresh, or delete it — doing so could log out a
 * live `copilot` CLI session. We only look up a single, fixed service name
 * (no probing across candidate service names) and treat "not found" as a
 * normal, non-fatal outcome rather than an error.
 */
function readTokenFromMacKeychain(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child?.kill()
      resolve(null)
    }, KEYCHAIN_COMMAND_TIMEOUT_MS)

    const child = execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: KEYCHAIN_COMMAND_TIMEOUT_MS },
      (error, stdout) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        if (error) {
          resolve(null)
          return
        }
        const token = stdout.trim()
        resolve(token.length > 0 ? token : null)
      }
    )
  })
}

async function readOAuthToken(): Promise<CredentialsReadResult> {
  if (process.platform === 'darwin') {
    const token = await readTokenFromMacKeychain()
    return token ? { status: 'ok', token } : { status: 'missing' }
  }
  return readTokenFromConfigFiles()
}

// ---------------------------------------------------------------------------
// Token exchange payload parsing (see IEntitlementsData/IQuotaSnapshotData in
// microsoft/vscode's src/vs/workbench/services/accounts/browser/defaultAccount.ts)
// ---------------------------------------------------------------------------

type CopilotQuotaSnapshot = {
  percent_remaining?: number
  unlimited?: boolean
  quota_reset_at?: number
}

type CopilotTokenExchangeResponse = {
  quota_snapshots?: {
    premium_interactions?: CopilotQuotaSnapshot
  }
  quota_reset_date?: string
  quota_reset_date_utc?: string
}

function parseResetDescription(date: Date): string {
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function resolveResetTimestamp(
  snapshot: CopilotQuotaSnapshot,
  data: CopilotTokenExchangeResponse
): { resetsAt: number | null; resetDescription: string | null } {
  if (typeof snapshot.quota_reset_at === 'number') {
    const date = new Date(snapshot.quota_reset_at * 1000)
    if (!Number.isNaN(date.getTime())) {
      return { resetsAt: date.getTime(), resetDescription: parseResetDescription(date) }
    }
  }
  const isoReset = data.quota_reset_date_utc ?? data.quota_reset_date
  if (isoReset) {
    const date = new Date(isoReset)
    if (!Number.isNaN(date.getTime())) {
      return { resetsAt: date.getTime(), resetDescription: parseResetDescription(date) }
    }
  }
  return { resetsAt: null, resetDescription: null }
}

function mapMonthlyWindow(data: CopilotTokenExchangeResponse): RateLimitWindow | null {
  const snapshot = data.quota_snapshots?.premium_interactions
  if (!snapshot || snapshot.unlimited || typeof snapshot.percent_remaining !== 'number') {
    return null
  }
  const { resetsAt, resetDescription } = resolveResetTimestamp(snapshot, data)
  return {
    usedPercent: Math.min(100, Math.max(0, 100 - snapshot.percent_remaining)),
    windowMinutes: MONTHLY_WINDOW_MINUTES,
    resetsAt,
    resetDescription
  }
}

function mapTokenExchangeResponse(data: CopilotTokenExchangeResponse): ProviderRateLimits {
  const monthly = mapMonthlyWindow(data)
  return {
    provider: 'copilot',
    session: null,
    weekly: null,
    monthly,
    updatedAt: Date.now(),
    error: monthly ? null : 'Copilot usage response did not include a premium interactions quota',
    status: monthly ? 'ok' : 'error'
  }
}

function result(status: ProviderRateLimits['status'], error: string | null): ProviderRateLimits {
  return {
    provider: 'copilot',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status
  }
}

/**
 * Read-only usage for GitHub Copilot.
 *
 * Why read-only: the OAuth token lives in the macOS Keychain (service
 * `copilot-cli`) or in `~/.config/github-copilot/{apps,hosts}.json` on
 * Linux/Windows, and is owned by the Copilot CLI's own login flow. Orca must
 * never write, refresh, or invalidate it. We only read the current token and
 * call the same token-exchange endpoint every Copilot client uses to learn
 * the account's premium-interactions quota.
 */
export async function fetchCopilotRateLimits(): Promise<ProviderRateLimits> {
  const readResult = await readOAuthToken()
  if (readResult.status === 'missing') {
    return result('unavailable', 'Not signed in to GitHub Copilot')
  }
  if (readResult.status === 'error') {
    return result('error', readResult.error)
  }

  try {
    const res = await net.fetch(TOKEN_EXCHANGE_URL, {
      headers: { Authorization: `Bearer ${readResult.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
    if (res.status === 401 || res.status === 403) {
      return result('error', `Copilot usage request unauthorized (HTTP ${res.status})`)
    }
    if (!res.ok) {
      return result('error', `Copilot usage request failed (HTTP ${res.status})`)
    }
    const data: unknown = await res.json()
    return mapTokenExchangeResponse(typeof data === 'object' && data !== null ? data : {})
  } catch (err) {
    return result('error', err instanceof Error ? err.message : 'Copilot usage request failed')
  }
}
