import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const API_TIMEOUT_MS = 15_000
const SUPPORTED_HOSTS = new Set(['api.z.ai', 'open.bigmodel.cn', 'dev.bigmodel.cn'])

type ZcodeProviderOptions = {
  apiKey?: unknown
  baseURL?: unknown
}

type ZcodeConfig = {
  model?: { main?: unknown }
  provider?: Record<string, { options?: ZcodeProviderOptions }>
}

type QuotaLimit = {
  type?: unknown
  percentage?: unknown
  nextResetTime?: unknown
}

type QuotaResponse = {
  success?: unknown
  msg?: unknown
  data?: {
    level?: unknown
    limits?: unknown
  }
}

type ZcodeUsageCredentials = {
  apiKey: string
  quotaUrl: string
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

function failed(error: string, failureKind: 'network' | 'server' | 'parse'): ProviderRateLimits {
  return {
    provider: 'zcode',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: { source: 'web', failureKind }
  }
}

function readCredentials(configPath: string): ZcodeUsageCredentials | null {
  let config: ZcodeConfig
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as ZcodeConfig
  } catch {
    return null
  }

  const mainProvider =
    typeof config.model?.main === 'string' ? config.model.main.split('/', 1)[0] : null
  const candidates = Object.entries(config.provider ?? {}).sort(([left], [right]) => {
    if (left === mainProvider) {
      return -1
    }
    if (right === mainProvider) {
      return 1
    }
    return 0
  })

  for (const [, provider] of candidates) {
    const apiKey = provider.options?.apiKey
    const baseURL = provider.options?.baseURL
    if (typeof apiKey !== 'string' || !apiKey.trim() || typeof baseURL !== 'string') {
      continue
    }
    try {
      const parsed = new URL(baseURL)
      if (parsed.protocol !== 'https:' || !SUPPORTED_HOSTS.has(parsed.hostname)) {
        continue
      }
      return {
        apiKey: apiKey.trim(),
        quotaUrl: `${parsed.origin}/api/monitor/usage/quota/limit`
      }
    } catch {
      continue
    }
  }
  return null
}

function asPercentage(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : null
}

function asResetTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function asWindow(limit: QuotaLimit | undefined, windowMinutes: number): RateLimitWindow | null {
  if (!limit) {
    return null
  }
  const usedPercent = asPercentage(limit.percentage)
  if (usedPercent === null) {
    return null
  }
  return {
    usedPercent,
    windowMinutes,
    resetsAt: asResetTime(limit.nextResetTime),
    resetDescription: null
  }
}

export async function fetchZcodeRateLimits(
  options: {
    configPath?: string
    signal?: AbortSignal
  } = {}
): Promise<ProviderRateLimits> {
  const configPath = options.configPath ?? join(homedir(), '.zcode', 'cli', 'config.json')
  const credentials = readCredentials(configPath)
  if (!credentials) {
    return unavailable('ZCode Coding Plan credentials are not configured')
  }

  let response: Response
  try {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(API_TIMEOUT_MS)])
      : AbortSignal.timeout(API_TIMEOUT_MS)
    response = await fetch(credentials.quotaUrl, {
      method: 'GET',
      headers: {
        Authorization: credentials.apiKey,
        'Accept-Language': 'en-US,en',
        'Content-Type': 'application/json'
      },
      signal
    })
  } catch (error) {
    return failed(error instanceof Error ? error.message : 'ZCode quota request failed', 'network')
  }

  if (!response.ok) {
    return failed(`ZCode quota request failed (${response.status})`, 'server')
  }

  let payload: QuotaResponse
  try {
    payload = (await response.json()) as QuotaResponse
  } catch {
    return failed('Could not parse ZCode quota response', 'parse')
  }
  if (payload.success !== true || !Array.isArray(payload.data?.limits)) {
    const message = typeof payload.msg === 'string' ? payload.msg : 'Invalid ZCode quota response'
    return failed(message, 'parse')
  }

  const limits = payload.data.limits.filter(
    (value): value is QuotaLimit => typeof value === 'object' && value !== null
  )
  const tokenLimits = limits
    .filter((limit) => limit.type === 'TOKENS_LIMIT')
    .sort(
      (left, right) =>
        (asResetTime(left.nextResetTime) ?? Number.MAX_SAFE_INTEGER) -
        (asResetTime(right.nextResetTime) ?? Number.MAX_SAFE_INTEGER)
    )
  const monthlyLimit = limits.find((limit) => limit.type === 'TIME_LIMIT')
  const session = asWindow(tokenLimits[0], 300)
  const weekly = asWindow(tokenLimits[1], 10080)
  const monthly = asWindow(monthlyLimit, 43200)
  if (!session && !weekly && !monthly) {
    return failed('ZCode quota response contained no usable limits', 'parse')
  }

  return {
    provider: 'zcode',
    session,
    weekly,
    monthly,
    planType: typeof payload.data.level === 'string' ? payload.data.level : null,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'web', credentialSource: configPath }
  }
}
