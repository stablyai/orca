import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execSecurityCommand, isKeychainNotFoundError } from '../macos-keychain/generic-password'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import type {
  ProviderRateLimits,
  RateLimitWindow,
  UsageRateLimitFailureKind
} from '../../shared/rate-limit-types'

const API_TIMEOUT_MS = 15_000
// Why /copilot_internal/user and not /copilot_internal/v2/token: both carry
// quota_snapshots, but v2/token also mints a Copilot bearer. Reading the user
// endpoint keeps Orca strictly read-only against the user's Copilot session.
const COPILOT_USER_URL = 'https://api.github.com/copilot_internal/user'
const KEYCHAIN_SERVICE = 'copilot-cli'
const MONTHLY_WINDOW_MINUTES = 30 * 24 * 60
const CREDENTIAL_IDENTITY_KEY = randomBytes(32)

export type CopilotTokenSource = 'github-copilot-config' | 'macos-keychain'

type CopilotToken = { token: string; source: CopilotTokenSource }

type TokenRead =
  | { status: 'ok'; token: CopilotToken }
  | { status: 'missing' }
  | { status: 'error'; error: string }

// Why: a denied keychain prompt must not re-prompt on every poll. Once the user
// (or code signing) refuses access, stop asking until Orca restarts.
let keychainDenied = false

export function resetCopilotKeychainDenialForTests(): void {
  keychainDenied = false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUsableToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value)
}

/** The shared `github-copilot` config dir used by copilot.vim, Neovim, Zed, and JetBrains. */
export function getGithubCopilotConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string {
  if (platform === 'win32' && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, 'github-copilot')
  }
  const xdg = env.XDG_CONFIG_HOME?.trim()
  return join(xdg ? xdg : join(home, '.config'), 'github-copilot')
}

/**
 * apps.json is keyed `github.com:<client-id>`; hosts.json is keyed `github.com`.
 * Only github.com entries are accepted so a GHE token is never sent to github.com.
 */
function readTokenFromConfigFile(path: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }
  for (const [host, entry] of Object.entries(parsed)) {
    if (host !== 'github.com' && !host.startsWith('github.com:')) {
      continue
    }
    if (isRecord(entry) && isUsableToken(entry.oauth_token)) {
      return entry.oauth_token.trim()
    }
  }
  return null
}

function readFileToken(configDir: string): TokenRead {
  for (const file of ['apps.json', 'hosts.json']) {
    const token = readTokenFromConfigFile(join(configDir, file))
    if (token) {
      return { status: 'ok', token: { token, source: 'github-copilot-config' } }
    }
  }
  return { status: 'missing' }
}

async function readKeychainToken(): Promise<TokenRead> {
  if (process.platform !== 'darwin' || keychainDenied) {
    return { status: 'missing' }
  }
  try {
    // Why no -a: the Copilot CLI stores one item per signed-in login under an
    // account name Orca cannot know up front; the first match is the active one.
    const { stdout } = await execSecurityCommand([
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-w'
    ])
    const token = stdout.trim()
    return isUsableToken(token)
      ? { status: 'ok', token: { token, source: 'macos-keychain' } }
      : { status: 'missing' }
  } catch (error) {
    if (isKeychainNotFoundError(error)) {
      return { status: 'missing' }
    }
    keychainDenied = true
    return {
      status: 'error',
      error: 'Unable to read the Copilot CLI login from the macOS Keychain'
    }
  }
}

/** Read-only: file sources first (portable, never prompt), then the macOS Keychain. */
export async function readCopilotToken(
  options: { configDir?: string; skipKeychain?: boolean } = {}
): Promise<TokenRead> {
  const fileRead = readFileToken(options.configDir ?? getGithubCopilotConfigDir())
  if (fileRead.status === 'ok' || options.skipKeychain) {
    return fileRead
  }
  return readKeychainToken()
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asResetTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Maps a `quota_snapshots.*` bucket to a monthly window; unlimited buckets yield null. */
export function toCopilotWindow(
  snapshot: unknown,
  resetsAt: number | null
): RateLimitWindow | null {
  if (!isRecord(snapshot) || snapshot.unlimited === true) {
    return null
  }
  const entitlement = asNumber(snapshot.entitlement)
  const remaining = asNumber(snapshot.remaining)
  const percentRemaining = asNumber(snapshot.percent_remaining)
  let usedPercent: number | null = null
  if (entitlement !== null && entitlement > 0 && remaining !== null) {
    usedPercent = ((entitlement - remaining) / entitlement) * 100
  } else if (percentRemaining !== null) {
    usedPercent = 100 - percentRemaining
  }
  if (usedPercent === null) {
    return null
  }
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes: MONTHLY_WINDOW_MINUTES,
    resetsAt,
    resetDescription:
      entitlement !== null && remaining !== null
        ? `${Math.max(0, entitlement - remaining).toLocaleString('en-US')} / ${entitlement.toLocaleString('en-US')} premium requests used`
        : null
  }
}

function base(): Pick<ProviderRateLimits, 'provider' | 'session' | 'weekly' | 'monthly'> {
  return { provider: 'copilot', session: null, weekly: null, monthly: null }
}

function unavailable(error: string): ProviderRateLimits {
  return {
    ...base(),
    updatedAt: Date.now(),
    error,
    status: 'unavailable',
    usageMetadata: { source: 'web', failureKind: 'missing-credentials' }
  }
}

function failed(
  error: string,
  failureKind: UsageRateLimitFailureKind,
  authProvenance?: string
): ProviderRateLimits {
  return {
    ...base(),
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: { source: 'web', failureKind, authProvenance }
  }
}

export async function fetchCopilotRateLimits(
  options: { configDir?: string; skipKeychain?: boolean; signal?: AbortSignal } = {}
): Promise<ProviderRateLimits> {
  const tokenRead = await readCopilotToken(options)
  if (tokenRead.status === 'error') {
    return failed(tokenRead.error, 'keychain-unavailable')
  }
  if (tokenRead.status === 'missing') {
    return unavailable('GitHub Copilot login not found')
  }
  const { token, source } = tokenRead.token
  // Why HMAC: lets the stale policy detect an account switch without retaining the token.
  const authProvenance = createHmac('sha256', CREDENTIAL_IDENTITY_KEY).update(token).digest('hex')

  let response: Response
  try {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(API_TIMEOUT_MS)])
      : AbortSignal.timeout(API_TIMEOUT_MS)
    response = await fetch(COPILOT_USER_URL, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/json',
        'X-GitHub-Api-Version': '2025-04-01'
      },
      signal
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Copilot quota request failed'
    return failed(message.replaceAll(token, '[redacted]'), 'network', authProvenance)
  }

  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    // Why: 401 = revoked/expired login; 403/404 = signed in but no Copilot seat.
    const kind: UsageRateLimitFailureKind =
      response.status === 401
        ? 'stale-token'
        : response.status === 403 || response.status === 404
          ? 'no-subscription'
          : response.status === 429
            ? 'rate-limited'
            : 'server'
    return failed(`Copilot quota request failed (${response.status})`, kind, authProvenance)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return failed('Could not parse Copilot quota response', 'parse', authProvenance)
  }
  if (!isRecord(payload) || !isRecord(payload.quota_snapshots)) {
    return failed('Copilot quota response contained no quota snapshots', 'parse', authProvenance)
  }
  const resetsAt = asResetTime(payload.quota_reset_date_utc ?? payload.quota_reset_date)
  // Why premium_interactions: it is the metered "credits" bucket VS Code shows;
  // chat/completions are unlimited on every paid plan.
  const monthly = toCopilotWindow(payload.quota_snapshots.premium_interactions, resetsAt)

  return {
    ...base(),
    monthly,
    planType: typeof payload.copilot_plan === 'string' ? payload.copilot_plan : null,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'web', credentialSource: source, authProvenance }
  }
}
