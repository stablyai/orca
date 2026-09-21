import { net } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { readOpenRouterApiKey } from '../openrouter/openrouter-api-key-store'

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1'
const KEY_URL = `${OPENROUTER_API_BASE}/key`
const CREDITS_URL = `${OPENROUTER_API_BASE}/credits`
const API_TIMEOUT_MS = 10_000
const MONTHLY_WINDOW_MINUTES = 43_200

type OpenRouterKeyData = {
  limit?: number | null
  limit_remaining?: number | null
  limit_reset?: string | null
  usage?: number | null
  is_free_tier?: boolean
}

type OpenRouterCreditsData = {
  total_credits?: number | null
  total_usage?: number | null
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  extra: Partial<ProviderRateLimits> = {}
): ProviderRateLimits {
  return {
    provider: 'openrouter',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...extra
  }
}

/**
 * OpenRouter reports the cap's cadence as a word (`limit_reset: "monthly"`),
 * never an instant. The window therefore carries no `resetsAt`, and the status
 * bar falls back to the window-length label — inventing a reset timestamp from
 * the cadence would put a countdown on screen that OpenRouter never promised.
 */
function spendWindow(usedPercent: number): RateLimitWindow {
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowMinutes: MONTHLY_WINDOW_MINUTES,
    resetsAt: null,
    resetDescription: null
  }
}

type OpenRouterFetchOutcome =
  | { kind: 'data'; data: unknown }
  | { kind: 'result'; result: ProviderRateLimits }

async function fetchOpenRouterJson(
  url: string,
  key: string,
  signal?: AbortSignal
): Promise<OpenRouterFetchOutcome> {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS)
  const res = await net.fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: requestSignal
  })
  if (res.status === 401 || res.status === 403) {
    return {
      kind: 'result',
      result: result('error', 'OpenRouter rejected the API key', {
        usageMetadata: { source: 'web', failureKind: 'stale-token' }
      })
    }
  }
  if (res.status === 429) {
    return {
      kind: 'result',
      result: result('error', 'OpenRouter usage request rate limited', {
        usageMetadata: { source: 'web', failureKind: 'rate-limited' }
      })
    }
  }
  if (!res.ok) {
    return {
      kind: 'result',
      result: result('error', `OpenRouter usage request failed (HTTP ${res.status})`, {
        usageMetadata: { source: 'web', failureKind: 'server' }
      })
    }
  }
  return { kind: 'data', data: await res.json() }
}

function unwrapData(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    return {}
  }
  const data = (payload as { data?: unknown }).data
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
}

// Why: the key's own cap is what OpenRouter enforces per request, so it is the
// ceiling a user means by "how much have I got left"; the account balance is
// only meaningful when the key itself is uncapped.
export async function fetchOpenRouterRateLimits(
  options: { signal?: AbortSignal; apiKey?: string | null } = {}
): Promise<ProviderRateLimits> {
  let key: string | null
  try {
    key = options.apiKey !== undefined ? options.apiKey : readOpenRouterApiKey()
  } catch (error) {
    return result('error', error instanceof Error ? error.message : 'OpenRouter key unreadable', {
      usageMetadata: { failureKind: 'missing-credentials' }
    })
  }
  if (!key) {
    return result('unavailable', 'No OpenRouter API key configured', {
      usageMetadata: { failureKind: 'missing-credentials' }
    })
  }

  try {
    const outcome = await fetchOpenRouterJson(KEY_URL, key, options.signal)
    if (outcome.kind === 'result') {
      return outcome.result
    }
    const data = unwrapData(outcome.data) as OpenRouterKeyData
    const limit = typeof data.limit === 'number' && Number.isFinite(data.limit) ? data.limit : null
    const remaining =
      typeof data.limit_remaining === 'number' && Number.isFinite(data.limit_remaining)
        ? data.limit_remaining
        : null
    const planType = typeof data.limit_reset === 'string' ? data.limit_reset : null

    if (limit !== null && limit > 0 && remaining !== null) {
      // Why: spend is `limit - limit_remaining`, not `usage`. On a key whose cap
      // resets, `usage` is the key's lifetime spend and would over-report against
      // a periodic ceiling once the first period rolls over; `limit_remaining` is
      // always the headroom left in the current period.
      const spent = limit - remaining
      return result('ok', null, {
        monthly: spendWindow((spent / limit) * 100),
        planType,
        usageMetadata: { source: 'web' }
      })
    }

    // Uncapped key: the account credit balance is the only remaining ceiling.
    const creditsOutcome = await fetchOpenRouterJson(CREDITS_URL, key, options.signal)
    if (creditsOutcome.kind === 'result') {
      // Why surface this rather than fall through: with no cap on the key, the
      // balance is the only ceiling left, so a failed read means the headroom is
      // unknown — not that there is none. Reporting 'unavailable' here would
      // also discard the previous reading, where an error keeps it.
      return creditsOutcome.result
    }
    const credits = unwrapData(creditsOutcome.data) as OpenRouterCreditsData
    const total = typeof credits.total_credits === 'number' ? credits.total_credits : null
    const spent = typeof credits.total_usage === 'number' ? credits.total_usage : null
    if (total !== null && total > 0 && spent !== null) {
      return result('ok', null, {
        monthly: spendWindow((spent / total) * 100),
        planType,
        usageMetadata: { source: 'web' }
      })
    }

    // Why: a key with no cap and no purchased credits is a working key with no
    // ceiling to meter. 'unavailable' hides the bar rather than showing 0% of
    // nothing, and matches how Claude behaves on API-key billing.
    return result('unavailable', 'OpenRouter key has no spend limit configured', { planType })
  } catch (err) {
    return result('error', err instanceof Error ? err.message : 'OpenRouter usage request failed', {
      usageMetadata: { source: 'web', failureKind: 'network' }
    })
  }
}
