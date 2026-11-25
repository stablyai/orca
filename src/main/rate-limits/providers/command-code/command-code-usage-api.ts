import { ensureElectronProxyFromEnvironment } from '../../../network/proxy-settings'
import { getMainHttpClient } from '../../../network/http-client'
import { abortSignalWithTimeout } from '../../../lib/abort-signal-with-timeout'
import { cancelUnreadResponseBody } from '../../../lib/unread-response-body'
import { classifyThrownUsageRequestError } from '../usage-request-failure-kind'
import { normalizeCommandCodeUsage } from './command-code-usage-normalize'
import type {
  ProviderRateLimits,
  UsageRateLimitFailureKind
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'

// VERIFIED: routes and response shapes confirmed against live Command Code responses.
export const COMMAND_CODE_API_BASE_URL = 'https://api.commandcode.ai'
export const COMMAND_CODE_CREDITS_PATH = '/alpha/billing/credits'
export const COMMAND_CODE_SUBSCRIPTIONS_PATH = '/alpha/billing/subscriptions'
const API_TIMEOUT_MS = 15_000

type JsonRead =
  | { kind: 'ok'; value: unknown }
  | { kind: 'failed'; failureKind: UsageRateLimitFailureKind; status?: number }

function failed(
  error: string,
  failureKind: UsageRateLimitFailureKind,
  status: ProviderRateLimits['status'] = 'error'
): ProviderRateLimits {
  return {
    provider: 'command-code',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: { source: 'web', failureKind }
  }
}

export function unconfiguredCommandCodeUsage(): ProviderRateLimits {
  return failed('Command Code API key is not configured', 'missing-credentials', 'unavailable')
}

async function getJson(path: string, apiKey: string, signal?: AbortSignal): Promise<JsonRead> {
  let response: Response
  try {
    response = await getMainHttpClient().fetch(`${COMMAND_CODE_API_BASE_URL}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: abortSignalWithTimeout(signal, API_TIMEOUT_MS)
    })
  } catch (error) {
    // Exception text can echo the request, so only the error class is surfaced.
    return { kind: 'failed', failureKind: classifyThrownUsageRequestError(error) }
  }
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    if (response.status === 401) {
      return { kind: 'failed', failureKind: 'missing-credentials', status: response.status }
    }
    if (response.status === 403) {
      // A 403 can mean the plan lacks API access, not that the key is wrong.
      return { kind: 'failed', failureKind: 'no-subscription', status: response.status }
    }
    if (response.status === 429) {
      return { kind: 'failed', failureKind: 'rate-limited', status: response.status }
    }
    return { kind: 'failed', failureKind: 'server', status: response.status }
  }
  try {
    const value: unknown = JSON.parse(await response.text())
    return { kind: 'ok', value }
  } catch (error) {
    // A body read can fail for transport reasons too; keep those distinct from JSON syntax errors.
    return { kind: 'failed', failureKind: classifyThrownUsageRequestError(error) }
  }
}

function describeShape(read: JsonRead): string {
  if (read.kind === 'failed') {
    return read.status === undefined ? read.failureKind : `HTTP ${read.status}`
  }
  const value = read.value
  const record = Array.isArray(value) ? value[0] : value
  if (typeof record !== 'object' || record === null) {
    return typeof value
  }
  const keys = Object.keys(record).slice(0, 20)
  return Array.isArray(value)
    ? `array[${value.length}] of {${keys.join(', ')}}`
    : `{${keys.join(', ')}}`
}

/** Reads both billing routes with the saved key; a rejected key fails without any fallback source. */
export async function fetchCommandCodeRateLimits(input: {
  apiKey: string
  signal?: AbortSignal
}): Promise<ProviderRateLimits> {
  await ensureElectronProxyFromEnvironment({ probeUrl: COMMAND_CODE_API_BASE_URL }).catch(() => {})
  const [credits, subscriptions] = await Promise.all([
    getJson(COMMAND_CODE_CREDITS_PATH, input.apiKey, input.signal),
    getJson(COMMAND_CODE_SUBSCRIPTIONS_PATH, input.apiKey, input.signal)
  ])
  // Either route rejecting the key settles it; a 404 on the other route does not hide that verdict.
  const rejected = [
    { label: 'credits', read: credits },
    { label: 'subscriptions', read: subscriptions }
  ].find(({ read }) => read.kind === 'failed' && read.failureKind === 'missing-credentials')
  if (rejected) {
    const status = rejected.read.kind === 'failed' ? rejected.read.status : undefined
    return failed(
      `Command Code rejected the saved API key (${rejected.label} returned HTTP ${status ?? 401})`,
      'missing-credentials'
    )
  }
  const entitlement = [credits, subscriptions].some(
    (read) => read.kind === 'failed' && read.failureKind === 'no-subscription'
  )
  if (entitlement) {
    return failed('This Command Code plan does not include API usage access', 'no-subscription')
  }
  if (credits.kind === 'failed' && subscriptions.kind === 'failed') {
    return failed('Command Code usage request failed', credits.failureKind)
  }
  const normalized = normalizeCommandCodeUsage({
    credits: credits.kind === 'ok' ? credits.value : null,
    subscriptions: subscriptions.kind === 'ok' ? subscriptions.value : null,
    now: Date.now()
  })
  if (!normalized.session && !normalized.weekly && !normalized.extraUsage) {
    // Key names only, never values: enough to see the real schema without leaking balances or identity.
    const shape = [
      `credits: ${describeShape(credits)}`,
      `subscriptions: ${describeShape(subscriptions)}`
    ].join('; ')
    return failed(`Could not read Command Code usage from the response (${shape})`, 'parse')
  }
  return {
    provider: 'command-code',
    session: normalized.session,
    weekly: normalized.weekly,
    extraUsage: normalized.extraUsage,
    planType: normalized.planType,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'web' }
  }
}
