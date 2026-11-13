import { createHmac, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readKiroCliCredentials } from '../../../foreign-sqlite-readers/foreign-sqlite-reader-spawn'
import type { KiroCliCredentialsReadResult } from '../../../foreign-sqlite-readers/kiro-cli-credentials-result'
import { cancelUnreadResponseBody } from '../../../lib/unread-response-body'
import type {
  ExtraUsageBalance,
  ProviderRateLimits,
  RateLimitWindow,
  UsageRateLimitFailureKind
} from '../../../../shared/rate-limit-types'

const API_TIMEOUT_MS = 10_000
const MONTHLY_WINDOW_MINUTES = 30 * 24 * 60
// GetUsageLimits is kiro-cli's private service contract, routed by the profile ARN's region.
const USAGE_ENDPOINTS: Readonly<Record<string, string>> = {
  'us-east-1': 'https://codewhisperer.us-east-1.amazonaws.com/',
  'eu-central-1': 'https://q.eu-central-1.amazonaws.com/'
}
// Plausible Unix seconds for a billing reset (2001 through 2100); anything else is a unit change.
const MIN_RESET_SECONDS = 1_000_000_000
const MAX_RESET_SECONDS = 4_102_444_800
const CREDENTIAL_IDENTITY_KEY = randomBytes(32)
const CREDENTIAL_SOURCE = 'kiro-cli'

type KiroCreditBreakdown = {
  resourceType?: unknown
  currentUsageWithPrecision?: unknown
  usageLimitWithPrecision?: unknown
  currentOveragesWithPrecision?: unknown
  overageCapWithPrecision?: unknown
  nextDateReset?: unknown
  bonuses?: unknown
}

export type KiroUsageFetchOptions = {
  signal?: AbortSignal
  dbPath?: string
  readCredentials?: (dbPath: string) => Promise<KiroCliCredentialsReadResult>
}

/**
 * Locate kiro-cli's state database for this OS.
 * @returns The data.sqlite3 path kiro-cli writes its login into.
 */
export function resolveKiroCliDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'kiro-cli', 'data.sqlite3')
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3')
  }
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'kiro-cli', 'data.sqlite3')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function snapshot(
  status: 'unavailable' | 'error',
  error: string,
  failureKind: UsageRateLimitFailureKind,
  authProvenance?: string
): ProviderRateLimits {
  return {
    provider: 'kiro',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: {
      source: 'oauth',
      failureKind,
      credentialSource: CREDENTIAL_SOURCE,
      authProvenance
    }
  }
}

function needsKiroCliRefresh(authProvenance?: string): ProviderRateLimits {
  // kiro-cli owns its token refresh; Orca never writes its database.
  return snapshot(
    'error',
    'Kiro CLI sign-in expired. Run kiro-cli on the computer running Orca, then retry usage.',
    'delegated-refresh-required',
    authProvenance
  )
}

function readProfileRegion(profileArn: string): string | null {
  // arn:aws:codewhisperer:<region>:<account>:profile/<id>
  const parts = profileArn.split(':')
  const isProfileArn =
    parts.length === 6 &&
    parts[0] === 'arn' &&
    parts[2] === 'codewhisperer' &&
    parts[5].startsWith('profile/') &&
    !/\s/.test(profileArn)
  return isProfileArn ? parts[3] : null
}

function toResetMs(value: unknown): number | null {
  const seconds = asNonNegativeNumber(value)
  if (seconds === null || seconds < MIN_RESET_SECONDS || seconds > MAX_RESET_SECONDS) {
    return null
  }
  return Math.round(seconds * 1000)
}

function mapOverage(
  credit: KiroCreditBreakdown,
  overageStatus: unknown,
  overageUsed: number,
  resetsAt: number | null
): ExtraUsageBalance | null {
  const cap = asNonNegativeNumber(credit.overageCapWithPrecision)
  // Only an enabled overage with a stated cap is a real second ceiling.
  if (overageStatus !== 'ENABLED' || cap === null || cap === 0) {
    return null
  }
  return {
    unit: 'credits',
    enabled: true,
    disabledReason: null,
    resetsAt,
    balance: Math.max(0, cap - overageUsed),
    unlimited: false
  }
}

function mapUsageLimits(payload: unknown, authProvenance: string): ProviderRateLimits {
  const parseFailure = (message: string): ProviderRateLimits =>
    snapshot('error', message, 'parse', authProvenance)
  if (!isRecord(payload) || !Array.isArray(payload.usageBreakdownList)) {
    return parseFailure('Invalid Kiro usage response')
  }
  const credits = payload.usageBreakdownList.filter(
    (item): item is KiroCreditBreakdown => isRecord(item) && item.resourceType === 'CREDIT'
  )
  if (credits.length !== 1) {
    return parseFailure('Kiro usage response did not report one credit balance')
  }
  const credit = credits[0]
  const limit = asNonNegativeNumber(credit.usageLimitWithPrecision)
  const totalUsed = asNonNegativeNumber(credit.currentUsageWithPrecision)
  const overageUsed = asNonNegativeNumber(credit.currentOveragesWithPrecision ?? 0)
  // currentUsage includes overage, so an overage above it is impossible.
  if (
    limit === null ||
    limit === 0 ||
    totalUsed === null ||
    overageUsed === null ||
    overageUsed > totalUsed
  ) {
    return parseFailure('Kiro usage response contained no usable credit limit')
  }
  const resetsAt = toResetMs(credit.nextDateReset ?? payload.nextDateReset)
  // A non-empty bonuses[] folds bonus spend into currentUsage, which then cannot be split from plan
  // usage. No plan gauge is better than one that reads full while plan credits remain.
  const hasUnseparatedBonus = Array.isArray(credit.bonuses) && credit.bonuses.length > 0
  // Plan usage excludes overage.
  const planUsed = totalUsed - overageUsed
  const monthly: RateLimitWindow | null = hasUnseparatedBonus
    ? null
    : {
        usedPercent: Math.min(100, (planUsed / limit) * 100),
        windowMinutes: MONTHLY_WINDOW_MINUTES,
        resetsAt,
        resetDescription: null
      }
  const overageConfiguration = isRecord(payload.overageConfiguration)
    ? payload.overageConfiguration
    : null
  const subscriptionInfo = isRecord(payload.subscriptionInfo) ? payload.subscriptionInfo : null
  const planTitle = subscriptionInfo?.subscriptionTitle
  return {
    provider: 'kiro',
    session: null,
    weekly: null,
    monthly,
    extraUsage: mapOverage(credit, overageConfiguration?.overageStatus, overageUsed, resetsAt),
    planType: typeof planTitle === 'string' && planTitle.trim() ? planTitle.trim() : null,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'oauth', credentialSource: CREDENTIAL_SOURCE, authProvenance }
  }
}

/**
 * Read Kiro monthly credit usage with kiro-cli's own login.
 * @returns `unavailable` when kiro-cli is not signed in, `error` with a failure kind, or `ok`.
 */
export async function fetchKiroRateLimits(
  options: KiroUsageFetchOptions = {}
): Promise<ProviderRateLimits> {
  const dbPath = options.dbPath ?? resolveKiroCliDatabasePath()
  const read = await (options.readCredentials ?? readKiroCliCredentials)(dbPath)
  if (read.status === 'missing') {
    return snapshot(
      'unavailable',
      'Not signed in to Kiro CLI. Run kiro-cli login.',
      'missing-credentials'
    )
  }
  if (read.status === 'error') {
    return snapshot('error', read.error, 'keychain-unavailable')
  }
  const { accessToken, expiresAt, profileArn } = read.credentials
  // An account is its profile ARN; the HMAC keeps that identifier out of the renderer.
  const authProvenance = createHmac('sha256', CREDENTIAL_IDENTITY_KEY)
    .update(profileArn)
    .digest('hex')
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN
  const isTokenExpired = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()
  if (isTokenExpired) {
    return needsKiroCliRefresh(authProvenance)
  }
  const region = readProfileRegion(profileArn)
  const endpoint = region ? USAGE_ENDPOINTS[region] : undefined
  if (!endpoint) {
    return snapshot(
      'error',
      `Kiro usage is not available for the ${region ?? 'unknown'} profile region`,
      'usage-unavailable',
      authProvenance
    )
  }

  let response: Response
  try {
    const timeout = AbortSignal.timeout(API_TIMEOUT_MS)
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/x-amz-json-1.0',
        'X-Amz-Target': 'AmazonCodeWhispererService.GetUsageLimits',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ profileArn }),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Kiro usage request failed'
    return snapshot(
      'error',
      message.replaceAll(accessToken, '[redacted]'),
      'network',
      authProvenance
    )
  }

  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    if (response.status === 401 || response.status === 403) {
      return needsKiroCliRefresh(authProvenance)
    }
    return snapshot(
      'error',
      `Kiro usage request failed (${response.status})`,
      response.status === 429 ? 'rate-limited' : 'server',
      authProvenance
    )
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return snapshot('error', 'Could not parse Kiro usage response', 'parse', authProvenance)
  }
  return mapUsageLimits(payload, authProvenance)
}
