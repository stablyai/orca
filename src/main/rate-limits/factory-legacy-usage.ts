import { net } from 'electron'
import type { RateLimitWindow } from '../../shared/rate-limit-types'

// Why: URLs and headers must match what the Factory web app sends or the API rejects the request.
export const FACTORY_API_BASE = 'https://api.factory.ai'
export const API_TIMEOUT_MS = 10_000
export const WEEKLY_WINDOW_MINUTES = 10_080
const LEGACY_USAGE_URL = `${FACTORY_API_BASE}/api/organization/subscription/usage?useCache=true`

export function makeFactoryRequestHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'x-factory-client': 'web-app'
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// Why: legacy responses predate quota windows; derive a weekly percent from
// used/allowance ratios so these accounts still see one bar.
function mapLegacyWeekly(data: unknown): RateLimitWindow | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const body = data as Record<string, unknown>
  const pools: unknown[] = []
  const usage = body.usage
  if (typeof usage === 'object' && usage !== null) {
    const usageBody = usage as Record<string, unknown>
    if (typeof usageBody.standard === 'object' && usageBody.standard !== null) {
      pools.push(usageBody.standard)
    }
    if (typeof usageBody.core === 'object' && usageBody.core !== null) {
      pools.push(usageBody.core)
    }
  }
  if (typeof body.standard === 'object' && body.standard !== null) {
    pools.push(body.standard)
  }
  for (const pool of pools) {
    const poolBody = pool as Record<string, unknown>
    const usedRatio = poolBody.usedRatio
    if (isFiniteNumber(usedRatio)) {
      return {
        usedPercent: Math.min(100, Math.max(0, usedRatio <= 1 ? usedRatio * 100 : usedRatio)),
        windowMinutes: WEEKLY_WINDOW_MINUTES,
        resetsAt: null,
        resetDescription: null
      }
    }
    const userTokens = poolBody.userTokens
    const totalAllowance = poolBody.totalAllowance
    if (isFiniteNumber(userTokens) && isFiniteNumber(totalAllowance) && totalAllowance > 0) {
      return {
        usedPercent: Math.min(100, Math.max(0, (userTokens / totalAllowance) * 100)),
        windowMinutes: WEEKLY_WINDOW_MINUTES,
        resetsAt: null,
        resetDescription: null
      }
    }
    const used = poolBody.used
    const allowance = poolBody.allowance
    if (isFiniteNumber(used) && isFiniteNumber(allowance) && allowance > 0) {
      return {
        usedPercent: Math.min(100, Math.max(0, (used / allowance) * 100)),
        windowMinutes: WEEKLY_WINDOW_MINUTES,
        resetsAt: null,
        resetDescription: null
      }
    }
  }
  return null
}

export type FactoryLegacyOutcome = { kind: 'weekly'; weekly: RateLimitWindow } | { kind: 'none' }

// Why: some plans report only the legacy subscription usage view; keep a
// weekly bar from it. Best-effort: any failure maps to 'none'.
export async function fetchFactoryLegacyWeekly(
  apiKey: string,
  signal?: AbortSignal
): Promise<FactoryLegacyOutcome> {
  try {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
      : AbortSignal.timeout(API_TIMEOUT_MS)
    const res = await net.fetch(LEGACY_USAGE_URL, {
      headers: makeFactoryRequestHeaders(apiKey),
      signal: requestSignal
    })
    if (!res.ok) {
      return { kind: 'none' }
    }
    const data: unknown = await res.json()
    const weekly = mapLegacyWeekly(data)
    return weekly ? { kind: 'weekly', weekly } : { kind: 'none' }
  } catch {
    return { kind: 'none' }
  }
}
