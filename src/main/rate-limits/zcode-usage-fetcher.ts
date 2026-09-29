import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const API_TIMEOUT_MS = 15_000
const SUPPORTED_HOSTS = new Set(['api.z.ai', 'open.bigmodel.cn', 'dev.bigmodel.cn'])
const CREDENTIAL_IDENTITY_KEY = randomBytes(32)

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

type ZcodeUsageCredentials = {
  apiKey: string
  quotaUrl: string
  authProvenance: string
}

// Why readers and not casts: both JSON sources are outside our control — a user-edited
// config file and a remote response — so their shape is a guess until something checks it.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function readMainProvider(model: unknown): string | null {
  const name = typeof model === 'string' ? model : readRecord(model)?.main
  if (typeof name !== 'string') {
    return null
  }
  const delimiter = name.indexOf('/')
  return delimiter > 0 && delimiter < name.length - 1 ? name.slice(0, delimiter) : null
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

function readCredentials(configPath: string): ZcodeUsageCredentials | null {
  let config: Record<string, unknown> | null
  try {
    config = readRecord(JSON.parse(readFileSync(configPath, 'utf8')))
  } catch {
    return null
  }

  if (!config) {
    return null
  }
  // A quota from another configured account must never appear as the selected model's quota.
  const mainProvider = readMainProvider(config.model)
  if (!mainProvider) {
    return null
  }
  const options = readRecord(readRecord(readRecord(config.provider)?.[mainProvider])?.options)
  const apiKey = options?.apiKey
  const baseURL = options?.baseURL
  if (
    typeof apiKey !== 'string' ||
    !apiKey.trim() ||
    /[\r\n]/.test(apiKey) ||
    typeof baseURL !== 'string'
  ) {
    return null
  }
  try {
    const parsed = new URL(baseURL)
    if (
      parsed.protocol !== 'https:' ||
      !SUPPORTED_HOSTS.has(parsed.hostname) ||
      (parsed.port !== '' && parsed.port !== '443')
    ) {
      return null
    }
    return {
      apiKey: apiKey.trim(),
      quotaUrl: `${parsed.origin}/api/monitor/usage/quota/limit`,
      authProvenance: createHmac('sha256', CREDENTIAL_IDENTITY_KEY)
        .update(JSON.stringify([mainProvider, parsed.origin, apiKey.trim()]))
        .digest('hex')
    }
  } catch {
    return null
  }
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
      error instanceof Error ? error.message : 'ZCode quota request failed',
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
    return failed(message, 'parse', credentials.authProvenance)
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
      credentialSource: configPath,
      authProvenance: credentials.authProvenance
    }
  }
}
