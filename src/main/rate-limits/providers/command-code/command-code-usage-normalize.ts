import type {
  ExtraUsageBalance,
  RateLimitWindow
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'

const MONTH_WINDOW_MINUTES = 30 * 24 * 60
const BALANCE_KEYS = ['balance', 'credits', 'availableCredits', 'remainingCredits', 'remaining']
const USED_KEYS = ['used', 'usage', 'consumed', 'current']
const LIMIT_KEYS = ['limit', 'total', 'quota', 'max']
const RESET_KEYS = ['resetsAt', 'resetAt', 'periodEnd', 'currentPeriodEnd', 'renewsAt']
const PLAN_KEYS = ['planType', 'plan', 'tier']

export type CommandCodeUsageNormalized = {
  monthly: RateLimitWindow | null
  extraUsage: ExtraUsageBalance | null
  planType: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Some responses wrap the payload in `data`; unwrap one level only. */
function unwrap(value: unknown): unknown {
  return isRecord(value) && isRecord(value.data) ? value.data : value
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = finiteNumber(record[key])
    if (value !== null) {
      return value
    }
  }
  return null
}

/** Timestamps may arrive as ms, seconds, or ISO strings; only future-or-current values are kept. */
function readResetMs(record: Record<string, unknown>, now: number): number | null {
  for (const key of RESET_KEYS) {
    const raw = record[key]
    let ms: number | null = null
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Date.parse(raw)
      ms = Number.isNaN(parsed) ? null : parsed
    } else {
      const numeric = finiteNumber(raw)
      if (numeric !== null && numeric > 0) {
        ms = numeric < 1e12 ? numeric * 1000 : numeric
      }
    }
    if (ms !== null && ms >= now - 60_000) {
      return ms
    }
  }
  return null
}

function readPlanType(payload: unknown): string | null {
  const record = unwrap(payload)
  const subscription = Array.isArray(record) ? record[0] : record
  if (!isRecord(subscription)) {
    return null
  }
  for (const key of PLAN_KEYS) {
    const value = subscription[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim()
    }
  }
  return null
}

function readBalance(payload: unknown): number | null {
  const record = unwrap(payload)
  if (typeof record === 'number') {
    return finiteNumber(record)
  }
  return isRecord(record) ? firstNumber(record, BALANCE_KEYS) : null
}

/** Subscription usage becomes the monthly window only when both used and limit are reported. */
function readMonthlyWindow(payload: unknown, now: number): RateLimitWindow | null {
  const record = unwrap(payload)
  const subscription = Array.isArray(record)
    ? record.find((entry) => isRecord(entry) && firstNumber(entry, LIMIT_KEYS) !== null)
    : record
  if (!isRecord(subscription)) {
    return null
  }
  const limit = firstNumber(subscription, LIMIT_KEYS)
  const used = firstNumber(subscription, USED_KEYS)
  if (limit === null || used === null || limit <= 0) {
    return null
  }
  return {
    usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
    windowMinutes: MONTH_WINDOW_MINUTES,
    resetsAt: readResetMs(subscription, now),
    resetDescription: null
  }
}

/** Command Code's usage routes are not publicly documented, so unknown shapes map to nulls rather than guesses. */
export function normalizeCommandCodeUsage(input: {
  credits: unknown
  subscriptions: unknown
  now: number
}): CommandCodeUsageNormalized {
  const balance = readBalance(input.credits)
  return {
    monthly: readMonthlyWindow(input.subscriptions, input.now),
    planType: readPlanType(input.subscriptions),
    extraUsage:
      balance === null
        ? null
        : {
            unit: 'credits',
            balance: Math.max(0, balance),
            unlimited: false,
            enabled: true,
            disabledReason: null,
            resetsAt: null
          }
  }
}
