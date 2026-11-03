import { z } from 'zod'
import { abortSignalWithTimeout } from '../lib/abort-signal-with-timeout'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import type {
  ExtraUsageBalance,
  ProviderRateLimits,
  RateLimitWindow
} from '../../shared/rate-limit-types'
import { OLLAMA_CLOUD_BASE_URL } from '../../shared/ollama-cloud'

/** Ollama cloud usage API: https://docs.ollama.com/api/balance.md, https://docs.ollama.com/api/cloud-usage.md */
const BALANCE_URL = `${OLLAMA_CLOUD_BASE_URL}/api/balance`
const USAGE_URL_30D = `${OLLAMA_CLOUD_BASE_URL}/api/usage?range=30d`
const API_TIMEOUT_MS = 15_000
export const OLLAMA_PROVIDER_ID = 'ollama' as const

const LegacyLimitSchema = z.object({
  remaining_percent: z.number().min(0).max(100),
  resets_at: z.string()
})

const UsageResponseSchema = z.object({
  totals: z.object({
    request_count: z.number(),
    usage_usd: z.number(),
    input_tokens: z.number().nullish(),
    cached_input_tokens: z.number().nullish(),
    output_tokens: z.number().nullish()
  })
})

// Union keeps each documented balance shape explicit: modern plans spend a USD allowance;
// legacy plans expose session/weekly percents. `purchased` is optional everywhere so a
// plan with no purchased credits still parses.
const BalanceResponseSchema = z.union([
  z.object({
    included: z.object({
      balance_usd: z.number(),
      allowance_usd: z.number(),
      period: z.object({ from: z.string(), until: z.string() })
    }),
    purchased: z.object({ balance_usd: z.number() })
  }),
  z.object({
    included: z.object({
      session: LegacyLimitSchema,
      weekly: LegacyLimitSchema
    }),
    purchased: z.object({ balance_usd: z.number() })
  })
])

function parseDateMs(value: string): number | null {
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : time
}

export type OllamaBalanceWindows = {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  extraUsage: ExtraUsageBalance | null
}

/** Modern plans spend down a USD allowance; legacy plans expose session/weekly percents. */
export function parseOllamaBalanceResponse(payload: unknown): OllamaBalanceWindows {
  const parsed = BalanceResponseSchema.safeParse(payload)
  if (!parsed.success) {
    return { session: null, weekly: null, extraUsage: null }
  }
  const { included, purchased } = parsed.data
  if ('balance_usd' in included) {
    const spent = included.allowance_usd - included.balance_usd
    return {
      session: null,
      weekly: null,
      extraUsage: {
        unit: 'currency',
        balance: included.balance_usd,
        currencyCode: 'USD',
        spent,
        spendLimit: included.allowance_usd,
        spentPercent:
          included.allowance_usd > 0
            ? Math.round((spent / included.allowance_usd) * 10000) / 100
            : null,
        enabled: true,
        disabledReason: null,
        resetsAt: parseDateMs(included.period.until)
      }
    }
  }
  const sessionResetsAt = parseDateMs(included.session.resets_at)
  const weeklyResetsAt = parseDateMs(included.weekly.resets_at)
  return {
    session: {
      usedPercent: 100 - included.session.remaining_percent,
      windowMinutes: 300,
      resetsAt: sessionResetsAt,
      resetDescription: null
    },
    weekly: {
      usedPercent: 100 - included.weekly.remaining_percent,
      windowMinutes: 10080,
      resetsAt: weeklyResetsAt,
      resetDescription: null
    },
    extraUsage: {
      unit: 'currency',
      balance: purchased.balance_usd,
      currencyCode: 'USD',
      spent: null,
      spendLimit: null,
      spentPercent: null,
      enabled: true,
      disabledReason: null,
      resetsAt: null
    }
  }
}

export type OllamaUsageTotals = {
  spentUsd: number | null
  requestCount: number | null
  inputTokens: number | null
  cachedInputTokens: number | null
  outputTokens: number | null
}

export function parseOllamaUsageResponse(payload: unknown): OllamaUsageTotals {
  const parsed = UsageResponseSchema.safeParse(payload)
  if (!parsed.success) {
    return {
      spentUsd: null,
      requestCount: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null
    }
  }
  return {
    spentUsd: parsed.data.totals.usage_usd,
    requestCount: parsed.data.totals.request_count,
    inputTokens: parsed.data.totals.input_tokens ?? null,
    cachedInputTokens: parsed.data.totals.cached_input_tokens ?? null,
    outputTokens: parsed.data.totals.output_tokens ?? null
  }
}

function failed(
  error: string,
  failureKind: 'network' | 'server' | 'parse',
  updatedAt: number
): ProviderRateLimitsShape {
  return {
    provider: OLLAMA_PROVIDER_ID,
    session: null,
    weekly: null,
    updatedAt,
    error,
    status: 'error',
    usageMetadata: { source: 'web', failureKind }
  }
}

export function ollamaCloudMissingCredentials(): ProviderRateLimitsShape {
  return {
    provider: OLLAMA_PROVIDER_ID,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'Ollama cloud credentials are not configured',
    status: 'unavailable',
    usageMetadata: { source: 'web', failureKind: 'missing-credentials' }
  }
}

type ProviderRateLimitsShape = ProviderRateLimits

/** 30d usage totals are Ollama-specific data; no fake monthly window, no invented quota percent. */
export async function fetchOllamaCloudRateLimits(options: {
  apiKey: string
  signal?: AbortSignal
  networkProxySettings?: unknown
}): Promise<ProviderRateLimitsShape> {
  const updatedAt = Date.now()
  const headers = {
    Authorization: `Bearer ${options.apiKey}`,
    'Content-Type': 'application/json'
  }
  const timeoutSignal = abortSignalWithTimeout(options.signal, API_TIMEOUT_MS)
  try {
    const [balanceResponse, usageResponse] = await Promise.all([
      fetch(BALANCE_URL, { method: 'GET', redirect: 'error', headers, signal: timeoutSignal }),
      fetch(USAGE_URL_30D, { method: 'GET', redirect: 'error', headers, signal: timeoutSignal })
    ])
    if (!balanceResponse.ok || !usageResponse.ok) {
      for (const response of [balanceResponse, usageResponse]) {
        if (!response.ok) {
          void cancelUnreadResponseBody(response)
        }
      }
      return failed(
        `Ollama usage request failed (${balanceResponse.status}/${usageResponse.status})`,
        'server',
        updatedAt
      )
    }
    const balance = parseOllamaBalanceResponse(await balanceResponse.json())
    const usage = parseOllamaUsageResponse(await usageResponse.json())
    if (!balance.extraUsage && !balance.session && !balance.weekly) {
      return failed('Could not parse Ollama balance response', 'parse', updatedAt)
    }
    return {
      provider: OLLAMA_PROVIDER_ID,
      session: balance.session,
      weekly: balance.weekly,
      extraUsage: balance.extraUsage,
      // 30d spend is totals data, not a quota window; renderer reads ollamaUsageTotals.
      ollamaUsageTotals: usage,
      updatedAt,
      error: null,
      status: 'ok',
      usageMetadata: { source: 'web' }
    }
  } catch (error) {
    return failed(
      error instanceof Error ? error.message : 'Ollama usage request failed',
      'network',
      updatedAt
    )
  }
}
