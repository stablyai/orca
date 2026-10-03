import {
  readZcodeUsageCredentials,
  resolveUsageCredentials,
  ZCODE_PLAN_CREDENTIAL_SOURCE,
  type ZcodePlanCredential,
  type ZcodeUsageCredentials,
  type ZcodeUsageCredentialOptions
} from './zcode-usage-credentials'
export {
  hasZcodeCliPlanCredentials,
  ZCODE_PLAN_CREDENTIAL_SOURCE,
  type ZcodePlanCredential
} from './zcode-usage-credentials'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const API_TIMEOUT_MS = 15_000

type QuotaLimit = {
  type?: unknown
  unit?: unknown
  number?: unknown
  usage?: unknown
  currentValue?: unknown
  remaining?: unknown
  percentage?: unknown
  nextResetTime?: unknown
}

// Why readers and not casts: both JSON sources are outside our control — a user-edited
// config file and a remote response — so their shape is a guess until something checks it.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function unavailable(error: string): ProviderRateLimits {
  return {
    provider: 'zcode',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status: 'unavailable',
    usageMetadata: { source: 'web', failureKind: 'missing-credentials' }
  }
}

function failed(
  error: string,
  failureKind: 'network' | 'server' | 'parse',
  authProvenance: string
): ProviderRateLimits {
  return {
    provider: 'zcode',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: { source: 'web', failureKind, authProvenance }
  }
}

function redactCredential(error: string, apiKey: string): string {
  return error.replaceAll(apiKey, '[redacted]')
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asUsedPercent(limit: QuotaLimit): number | null {
  const total = asNumber(limit.usage)
  if (total !== null && total > 0) {
    const current = asNumber(limit.currentValue)
    const remaining = asNumber(limit.remaining)
    if (current !== null || remaining !== null) {
      const used = current ?? total - (remaining ?? 0)
      return Math.min(100, Math.max(0, (used / total) * 100))
    }
  }
  const reported = asNumber(limit.percentage)
  return reported === null ? null : Math.min(100, Math.max(0, reported))
}

function asResetTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function asWindowMinutes(limit: QuotaLimit): number | null {
  if (limit.type === 'TIME_LIMIT' && limit.unit === 5 && limit.number === 1) {
    // Z.ai's monthly MCP marker is encoded as one minute.
    return 30 * 24 * 60
  }
  const multipliers: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 10080 }
  const unit = asNumber(limit.unit)
  const count = asNumber(limit.number)
  if (unit === null || count === null || !Number.isInteger(count) || count <= 0) {
    return null
  }
  const multiplier = multipliers[unit]
  return multiplier ? count * multiplier : null
}

function asWindow(limit: QuotaLimit | undefined): RateLimitWindow | null {
  if (!limit) {
    return null
  }
  const usedPercent = asUsedPercent(limit)
  const windowMinutes = asWindowMinutes(limit)
  if (usedPercent === null || windowMinutes === null) {
    return null
  }
  const reset = asResetTime(limit.nextResetTime)
  return {
    usedPercent,
    windowMinutes,
    resetsAt:
      windowMinutes === 300 && reset !== null && reset > Date.now() + 301 * 60_000 ? null : reset,
    resetDescription: null
  }
}

export async function fetchZcodeRateLimits(
  options: ZcodeUsageCredentialOptions & {
    planCredential?: ZcodePlanCredential | null
    signal?: AbortSignal
  } = {}
): Promise<ProviderRateLimits> {
  const plan = options.planCredential
  const saved = plan
    ? resolveUsageCredentials(plan.apiKey, plan.baseUrl, ZCODE_PLAN_CREDENTIAL_SOURCE)
    : null
  if (plan && !saved) {
    return failed('The saved GLM Coding Plan API key is unusable', 'parse', '')
  }
  const cli = saved ? null : readZcodeUsageCredentials(options)
  if (cli?.status === 'error') {
    return failed('Could not read the selected ZCode CLI Coding Plan credential', 'parse', '')
  }
  const credentials = saved ?? (cli?.status === 'ok' ? cli.credentials : null)
  if (!credentials) {
    return unavailable('ZCode Coding Plan credentials are not configured')
  }
  const source = saved ? ZCODE_PLAN_CREDENTIAL_SOURCE : cli?.status === 'ok' ? cli.source : ''
  const result = await fetchUsage(credentials, source, options.signal)
  if (!saved) {
    const current = readZcodeUsageCredentials(options)
    if (
      current.status !== 'ok' ||
      current.credentials.authProvenance !== credentials.authProvenance
    ) {
      return unavailable('ZCode Coding Plan account changed during refresh')
    }
  }
  return { ...result, usageMetadata: { ...result.usageMetadata, credentialSource: source } }
}

async function fetchUsage(
  credentials: ZcodeUsageCredentials,
  credentialSource: string,
  callerSignal?: AbortSignal
): Promise<ProviderRateLimits> {
  let response: Response
  try {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(API_TIMEOUT_MS)])
      : AbortSignal.timeout(API_TIMEOUT_MS)
    response = await fetch(credentials.quotaUrl, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: credentials.apiKey,
        'Accept-Language': 'en-US,en',
        'Content-Type': 'application/json'
      },
      signal
    })
  } catch (error) {
    return failed(
      redactCredential(
        error instanceof Error ? error.message : 'ZCode quota request failed',
        credentials.apiKey
      ),
      'network',
      credentials.authProvenance
    )
  }

  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    return failed(
      `ZCode quota request failed (${response.status})`,
      'server',
      credentials.authProvenance
    )
  }

  let payload: Record<string, unknown> | null
  try {
    payload = readRecord(await response.json())
  } catch {
    return failed('Could not parse ZCode quota response', 'parse', credentials.authProvenance)
  }
  const data = readRecord(payload?.data)
  const code = payload?.code
  const reported = data?.limits
  if (
    payload?.success !== true ||
    (code !== undefined && code !== 0 && code !== 200) ||
    !Array.isArray(reported)
  ) {
    const msg = payload?.msg
    const message = typeof msg === 'string' ? msg : 'Invalid ZCode quota response'
    return failed(
      redactCredential(message, credentials.apiKey),
      'parse',
      credentials.authProvenance
    )
  }

  const limits = reported.filter((value): value is QuotaLimit => isRecord(value))
  const planLimits = limits
    .filter((limit) => limit.type === 'TOKENS_LIMIT' || limit.type === 'CREDIT_LIMIT')
    .map(asWindow)
    .filter((limit): limit is RateLimitWindow => limit !== null)
    .sort((left, right) => left.windowMinutes - right.windowMinutes)
  const session = planLimits.find((limit) => limit.windowMinutes === 300) ?? null
  const weekly = planLimits.find((limit) => limit.windowMinutes === 10080) ?? null
  const monthly = asWindow(limits.find((limit) => limit.type === 'TIME_LIMIT'))
  if (!session && !weekly && !monthly) {
    return failed(
      'ZCode quota response contained no usable limits',
      'parse',
      credentials.authProvenance
    )
  }

  return {
    provider: 'zcode',
    session,
    weekly,
    monthly,
    planType: typeof data?.level === 'string' ? data.level : null,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: {
      source: 'web',
      credentialSource,
      authProvenance: credentials.authProvenance
    }
  }
}
