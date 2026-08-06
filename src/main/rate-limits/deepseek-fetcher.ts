import { net } from 'electron'
import type {
  ProviderRateLimits,
  RateLimitWindow,
  UsageRateLimitMetadata
} from '../../shared/rate-limit-types'

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const API_TIMEOUT_MS = 10_000
// Why: prepaid balance is not a rolling quota; monthly-ish window keeps hasUsageData true for the status bar.
const MONTHLY_WINDOW_MINUTES = 43_200

type DeepSeekBalanceInfo = {
  currency?: unknown
  total_balance?: unknown
  granted_balance?: unknown
  topped_up_balance?: unknown
}

type DeepSeekBalanceResponse = {
  is_available?: unknown
  balance_infos?: unknown
}

export function readDeepSeekApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.DEEPSEEK_API_KEY?.trim()
  return key ? key : null
}

export function isDeepSeekAuthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readDeepSeekApiKey(env) !== null
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  usageMetadata?: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    provider: 'deepseek',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...(usageMetadata ? { usageMetadata } : {})
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asBalance(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function pickBalanceInfo(infos: unknown): DeepSeekBalanceInfo | null {
  if (!Array.isArray(infos) || infos.length === 0) {
    return null
  }
  const entries = infos.filter(
    (entry): entry is DeepSeekBalanceInfo => typeof entry === 'object' && entry !== null
  )
  if (entries.length === 0) {
    return null
  }
  const usd = entries.find((entry) => asString(entry.currency)?.toUpperCase() === 'USD')
  return usd ?? entries[0]
}

function mapBalanceWindow(info: DeepSeekBalanceInfo, isAvailable: boolean): RateLimitWindow | null {
  const totalBalance = asBalance(info.total_balance)
  if (totalBalance === null) {
    return null
  }
  const currency = asString(info.currency)?.toUpperCase() ?? null
  const balanceAmountLabel = asString(info.total_balance) ?? String(totalBalance)
  const balanceLabel = currency !== null ? `${currency} ${balanceAmountLabel}` : balanceAmountLabel
  // Why: remaining prepaid credit is shown as "used %" for the status bar — 0% with credit left, 100% when depleted/unavailable.
  const usedPercent = isAvailable && totalBalance > 0 ? 0 : 100
  return {
    usedPercent,
    windowMinutes: MONTHLY_WINDOW_MINUTES,
    resetsAt: null,
    resetDescription: balanceLabel
  }
}

function mapBalanceResponse(data: DeepSeekBalanceResponse): ProviderRateLimits {
  const isAvailable = data.is_available === true
  const info = pickBalanceInfo(data.balance_infos)
  if (!info) {
    return result('error', 'DeepSeek balance response did not include balance_infos', {
      failureKind: 'parse',
      source: 'cli'
    })
  }
  const monthly = mapBalanceWindow(info, isAvailable)
  if (!monthly) {
    return result('error', 'DeepSeek balance response did not include a total_balance', {
      failureKind: 'parse',
      source: 'cli'
    })
  }
  const currency = asString(info.currency)?.toUpperCase() ?? null
  return {
    provider: 'deepseek',
    session: null,
    weekly: null,
    monthly,
    planType: currency,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: {
      source: 'cli',
      authProvenance: monthly.resetDescription
        ? `DeepSeek balance ${monthly.resetDescription}`
        : 'DeepSeek API key'
    }
  }
}

/**
 * Prepaid balance for DeepSeek via DEEPSEEK_API_KEY.
 *
 * Why: DeepSeek exposes remaining credit (not rolling rate-limit windows). Map the
 * preferred USD (else first) balance into the monthly slot so the status bar has
 * hasUsageData without inventing session/weekly quotas.
 */
export async function fetchDeepSeekRateLimits(
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}
): Promise<ProviderRateLimits> {
  const env = options.env ?? process.env
  const apiKey = readDeepSeekApiKey(env)
  if (!apiKey) {
    return result('unavailable', 'DeepSeek API key not set — export DEEPSEEK_API_KEY', {
      failureKind: 'missing-credentials',
      source: 'cli'
    })
  }

  try {
    const requestSignal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(API_TIMEOUT_MS)])
      : AbortSignal.timeout(API_TIMEOUT_MS)
    const res = await net.fetch(BALANCE_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      },
      signal: requestSignal
    })
    if (res.status === 401 || res.status === 403) {
      return result('error', `DeepSeek balance request unauthorized (HTTP ${res.status})`, {
        failureKind: 'stale-token',
        source: 'cli'
      })
    }
    if (!res.ok) {
      return result('error', `DeepSeek balance request failed (HTTP ${res.status})`, {
        failureKind: res.status >= 500 ? 'server' : 'unknown',
        source: 'cli'
      })
    }
    let data: unknown
    try {
      data = await res.json()
    } catch {
      return result('error', 'DeepSeek balance response was not valid JSON', {
        failureKind: 'parse',
        source: 'cli'
      })
    }
    if (typeof data !== 'object' || data === null) {
      return result('error', 'DeepSeek balance response was not an object', {
        failureKind: 'parse',
        source: 'cli'
      })
    }
    return mapBalanceResponse(data as DeepSeekBalanceResponse)
  } catch (err) {
    return result('error', err instanceof Error ? err.message : 'DeepSeek balance request failed', {
      failureKind: 'network',
      source: 'cli'
    })
  }
}
