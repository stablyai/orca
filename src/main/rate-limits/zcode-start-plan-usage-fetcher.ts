import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { abortSignalWithTimeout } from '../lib/abort-signal-with-timeout'
import type { ProviderRateLimits, RateLimitBucket } from '../../shared/rate-limit-types'
import {
  ZCODE_START_PLAN_CREDENTIAL_SOURCE,
  ZCODE_START_PLAN_ORIGIN,
  type ZcodeStartPlanCredential
} from './zcode-usage-credentials'

const API_TIMEOUT_MS = 15_000
/** Mirrors the ZCode desktop client version; the endpoint only requires the headers to be present. */
const ZCODE_CLIENT_VERSION = '3.17.2'

type StartPlanBalance = {
  show_name?: unknown
  meter?: unknown
  unit_type?: unknown
  capabilities?: unknown
  total_units?: unknown
  used_units?: unknown
  period_start?: unknown
  period_end?: unknown
  expires_at?: unknown
}

type StartPlanPlan = {
  name?: unknown
  status?: unknown
  priority?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function failed(
  error: string,
  failureKind: 'network' | 'server' | 'parse',
  credential: ZcodeStartPlanCredential
): ProviderRateLimits {
  return {
    provider: 'zcode',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: {
      source: 'web',
      failureKind,
      credentialSource: ZCODE_START_PLAN_CREDENTIAL_SOURCE,
      authProvenance: credential.authProvenance
    }
  }
}

function asStartPlanBucketName(balance: StartPlanBalance): string | null {
  const showName = typeof balance.show_name === 'string' ? balance.show_name.trim() : ''
  if (showName) {
    return showName
  }
  const capabilities = Array.isArray(balance.capabilities) ? balance.capabilities : []
  for (const capability of capabilities) {
    if (typeof capability === 'string' && capability.toLowerCase().startsWith('model:')) {
      const model = capability.slice(6).trim()
      if (model) {
        return model
      }
    }
  }
  return null
}

function asStartPlanBucket(balance: StartPlanBalance): RateLimitBucket | null {
  if (balance.meter !== 'model_usage' || balance.unit_type !== 'token') {
    return null
  }
  const total = asNumber(balance.total_units)
  const used = asNumber(balance.used_units)
  if (total === null || total <= 0 || used === null || used < 0) {
    return null
  }
  const name = asStartPlanBucketName(balance)
  if (!name) {
    return null
  }
  const start = asNumber(balance.period_start)
  const end = asNumber(balance.period_end)
  const expires = asNumber(balance.expires_at)
  const windowSeconds =
    start !== null && end !== null && end > start
      ? end - start
      : start !== null && expires !== null && expires > start
        ? expires - start
        : null
  if (windowSeconds === null || windowSeconds <= 0) {
    return null
  }
  return {
    name,
    usedPercent: Math.min(100, Math.max(0, (used / total) * 100)),
    windowMinutes: Math.round(windowSeconds / 60),
    resetsAt: expires !== null && expires > 0 ? expires * 1000 : null,
    resetDescription: null
  }
}

function asStartPlanPlanType(plans: StartPlanPlan[]): string | null {
  let best: { priority: number; name: string } | null = null
  for (const plan of plans) {
    if (plan.status !== 'active') {
      continue
    }
    const name = typeof plan.name === 'string' ? plan.name.trim() : ''
    if (!name) {
      continue
    }
    const priority = asNumber(plan.priority) ?? Number.NEGATIVE_INFINITY
    if (best === null || priority > best.priority) {
      best = { priority, name }
    }
  }
  return best?.name ?? null
}

/** Fetches Z.ai Start Plan usage buckets from the ZCode session-scoped billing endpoint. */
export async function fetchZcodeStartPlanUsage(
  credential: ZcodeStartPlanCredential,
  callerSignal?: AbortSignal
): Promise<ProviderRateLimits> {
  const url = `${ZCODE_START_PLAN_ORIGIN}/api/v1/zcode-plan/billing/balance?app_version=${ZCODE_CLIENT_VERSION}`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${credential.jwt}`,
        'User-Agent': `ZCode/${ZCODE_CLIENT_VERSION}`,
        'X-ZCode-App-Version': ZCODE_CLIENT_VERSION,
        'X-Device-Mid': credential.deviceMid
      },
      signal: abortSignalWithTimeout(callerSignal, API_TIMEOUT_MS)
    })
  } catch {
    return failed('ZCode Start Plan quota request failed', 'network', credential)
  }

  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    return failed(
      `ZCode Start Plan quota request failed (${response.status})`,
      'server',
      credential
    )
  }

  let payload: Record<string, unknown> | null
  try {
    payload = readRecord(await response.json())
  } catch {
    return failed('Could not parse ZCode Start Plan quota response', 'parse', credential)
  }
  const data = readRecord(payload?.data)
  const code = payload?.code
  const reported = data?.balances
  if ((code !== undefined && code !== 0 && code !== 200) || !Array.isArray(reported)) {
    const msg = payload?.msg
    const message =
      typeof msg === 'string' && msg
        ? msg.replaceAll(credential.jwt, '[redacted]')
        : 'Invalid ZCode Start Plan quota response'
    return failed(message, 'parse', credential)
  }

  const buckets = reported
    .filter((value): value is StartPlanBalance => isRecord(value))
    .map(asStartPlanBucket)
    .filter((bucket): bucket is RateLimitBucket => bucket !== null)
  if (buckets.length === 0) {
    return failed(
      'ZCode Start Plan quota response contained no usable balances',
      'parse',
      credential
    )
  }
  const plans = Array.isArray(data?.plans) ? data?.plans : []
  return {
    provider: 'zcode',
    session: null,
    weekly: null,
    buckets,
    planType: asStartPlanPlanType(plans.filter((value): value is StartPlanPlan => isRecord(value))),
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: {
      source: 'web',
      credentialSource: ZCODE_START_PLAN_CREDENTIAL_SOURCE,
      authProvenance: credential.authProvenance
    }
  }
}
