import { net } from 'electron'
import type {
  ProviderRateLimits,
  RateLimitWindow,
  UsageRateLimitMetadata
} from '../../shared/rate-limit-types'
import { resolveDevinCliVersion } from '../devin/devin-cli-data-dir'
import {
  readDevinCredentials,
  type DevinCredentials,
  type DevinCredentialsReadResult
} from './devin-credentials'
import {
  decodeGetUserStatusQuota,
  encodeGetUserStatusRequest,
  type DevinUserStatusQuota
} from './devin-user-status-wire'

// Why: Devin has no REST usage endpoint — plan tier and the daily/weekly quota
// windows come from the same SeatManagementService/GetUserStatus unary
// Connect-RPC the CLI issues for `devin auth status`. The request body is raw
// (unframed) protobuf; see devin-user-status-wire.ts for the schema notes.
const GET_USER_STATUS_PATH = '/exa.seat_management_pb.SeatManagementService/GetUserStatus'
const API_TIMEOUT_MS = 10_000

const DAILY_WINDOW_MINUTES = 1440
const WEEKLY_WINDOW_MINUTES = 10_080
// Why: a released-CLI identity version is required by the backend gate; the
// installed version from cached_version.json is preferred, this is the floor.
const FALLBACK_CLI_VERSION = '3000.6.2'

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  usageMetadata?: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    provider: 'devin',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...(usageMetadata ? { usageMetadata } : {})
  }
}

function parseResetDescription(unixSeconds: number | null): string | null {
  if (unixSeconds === null || !Number.isFinite(unixSeconds)) {
    return null
  }
  const date = new Date(unixSeconds * 1000)
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function mapQuotaWindow(
  remainingPercent: number | null,
  resetAtUnix: number | null,
  windowMinutes: number
): RateLimitWindow | null {
  if (remainingPercent === null) {
    return null
  }
  return {
    usedPercent: Math.min(100, Math.max(0, 100 - remainingPercent)),
    windowMinutes,
    resetsAt: resetAtUnix !== null ? resetAtUnix * 1000 : null,
    resetDescription: parseResetDescription(resetAtUnix)
  }
}

function quotaResult(quota: DevinUserStatusQuota): ProviderRateLimits {
  const session = mapQuotaWindow(
    quota.dailyQuotaRemainingPercent,
    quota.dailyQuotaResetAtUnix,
    DAILY_WINDOW_MINUTES
  )
  const weekly = mapQuotaWindow(
    quota.weeklyQuotaRemainingPercent,
    quota.weeklyQuotaResetAtUnix,
    WEEKLY_WINDOW_MINUTES
  )
  if (!session && !weekly) {
    // Why: a signed-in plan that reports no dated quota windows (credit-billed
    // plans omit them) has no visible quota. 'unavailable' also clears the
    // devinAuthConfigured probe in the apply step, so the bar hides instead
    // of pinning a permanent "--" slot.
    return result('unavailable', 'Devin did not report quota windows for this account')
  }
  return {
    provider: 'devin',
    session,
    weekly,
    planType: quota.planName,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: {
      source: 'oauth',
      authProvenance: quota.email ?? 'Devin account',
      credentialSource: 'credentials.toml'
    }
  }
}

function expiredSessionResult(): ProviderRateLimits {
  // Why: the session token lives in credentials.toml and is rotated by the
  // Devin CLI on its next run — Orca must never refresh it. Report the
  // delegated-refresh failure so the UI tells the user to run `devin`.
  return result(
    'error',
    'Devin session expired — run devin on the computer running Orca, then retry usage.',
    { failureKind: 'delegated-refresh-required', source: 'oauth' }
  )
}

async function fetchUserStatus(
  credentials: DevinCredentials,
  signal: AbortSignal | undefined
): Promise<
  { kind: 'quota'; quota: DevinUserStatusQuota } | { kind: 'result'; result: ProviderRateLimits }
> {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS)
  const cliVersion = resolveDevinCliVersion() ?? FALLBACK_CLI_VERSION
  const requestBody = encodeGetUserStatusRequest(credentials.sessionToken, cliVersion)
  const res = await net.fetch(`${credentials.apiServerUrl}${GET_USER_STATUS_PATH}`, {
    method: 'POST',
    // Why: net.fetch follows redirects by default and a 307/308 re-sends the
    // body — a redirect could carry sessionToken to an http:// target.
    redirect: 'error',
    headers: {
      'Content-Type': 'application/proto',
      'Connect-Protocol-Version': '1',
      Accept: '*/*'
    },
    body: Buffer.from(requestBody),
    signal: requestSignal
  })
  if (res.status === 401 || res.status === 403) {
    return { kind: 'result', result: expiredSessionResult() }
  }
  if (!res.ok) {
    return {
      kind: 'result',
      result: result('error', `Devin usage request failed (HTTP ${res.status})`)
    }
  }
  const quota = decodeGetUserStatusQuota(new Uint8Array(await res.arrayBuffer()))
  if (!quota) {
    return {
      kind: 'result',
      result: result('error', 'Devin usage response was not a valid user status')
    }
  }
  return { kind: 'quota', quota }
}

// Why read-only: the session token is written by `devin login`/the CLI's own
// session lifecycle; Orca only reads it and calls the same status endpoint the
// CLI does. A rejected token means the CLI must run again — never refresh it.
export async function fetchDevinRateLimits(
  options: { signal?: AbortSignal; credentialsReadResult?: DevinCredentialsReadResult } = {}
): Promise<ProviderRateLimits> {
  const readResult = options.credentialsReadResult ?? readDevinCredentials()
  if (readResult.status === 'missing') {
    return result('unavailable', 'Not signed in to Devin — run devin login')
  }
  if (readResult.status === 'error') {
    return result('error', readResult.error)
  }
  try {
    const outcome = await fetchUserStatus(readResult.credentials, options.signal)
    if (outcome.kind === 'result') {
      return outcome.result
    }
    return quotaResult(outcome.quota)
  } catch (err) {
    return result('error', err instanceof Error ? err.message : 'Devin usage request failed')
  }
}
