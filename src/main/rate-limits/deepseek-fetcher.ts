import { DeepSeekBalanceResponse } from '../../shared/deepseek-balance'
import type { ProviderRateLimits, UsageRateLimitFailureKind } from '../../shared/rate-limit-types'
import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'
import { getMainHttpClient } from '../network/http-client'

export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

export function deepSeekBalanceFailure(
  error: string | null,
  failureKind: UsageRateLimitFailureKind,
  status: 'error' | 'unavailable' = 'error'
): ProviderRateLimits {
  return {
    provider: 'deepseek',
    session: null,
    weekly: null,
    monthly: null,
    balance: null,
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: { failureKind }
  }
}

export async function fetchDeepSeekBalance(
  apiKey: string | null,
  signal?: AbortSignal
): Promise<ProviderRateLimits> {
  if (!apiKey) {
    return deepSeekBalanceFailure(null, 'missing-credentials', 'unavailable')
  }
  const timeout = AbortSignal.timeout(15_000)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response
  try {
    response = await getMainHttpClient().fetch(DEEPSEEK_BALANCE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'error',
      credentials: 'omit',
      signal: requestSignal
    })
  } catch {
    return deepSeekBalanceFailure(
      timeout.aborted ? 'DeepSeek balance request timed out' : 'DeepSeek balance request failed',
      'network'
    )
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    const auth = response.status === 401 || response.status === 403
    return deepSeekBalanceFailure(
      auth ? 'DeepSeek rejected the API key' : 'DeepSeek balance service returned an error',
      auth ? 'stale-token' : response.status === 429 ? 'rate-limited' : 'server'
    )
  }
  try {
    const parsed = DeepSeekBalanceResponse.safeParse(
      await readFetchResponseJsonWithinLimit<unknown>(response, 32_768)
    )
    if (!parsed.success) {
      return deepSeekBalanceFailure('DeepSeek returned an invalid balance', 'parse')
    }
    return {
      provider: 'deepseek',
      session: null,
      weekly: null,
      monthly: null,
      balance: parsed.data,
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
  } catch {
    return deepSeekBalanceFailure(
      requestSignal.aborted
        ? 'DeepSeek balance request timed out'
        : 'DeepSeek returned an invalid balance',
      requestSignal.aborted ? 'network' : 'parse'
    )
  }
}
