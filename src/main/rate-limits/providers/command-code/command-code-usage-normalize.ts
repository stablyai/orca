import type {
  ExtraUsageBalance,
  RateLimitWindow
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'

const SESSION_WINDOW_MINUTES = 5 * 60
const WEEK_WINDOW_MINUTES = 7 * 24 * 60

export type CommandCodeUsageNormalized = {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
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

/** Reset timestamps are epoch ms in the live shape; seconds and ISO strings are tolerated. */
function readResetMs(value: unknown, now: number): number | null {
  let ms: number | null = null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    ms = Number.isNaN(parsed) ? null : parsed
  } else {
    const numeric = finiteNumber(value)
    if (numeric !== null && numeric > 0) {
      ms = numeric < 1e12 ? numeric * 1000 : numeric
    }
  }
  return ms !== null && ms >= now - 60_000 ? ms : null
}

function readWindow(
  record: Record<string, unknown>,
  windowMinutes: number,
  now: number
): RateLimitWindow | null {
  const used = finiteNumber(record.used)
  const cap = finiteNumber(record.cap)
  if (used === null || cap === null || cap <= 0) {
    return null
  }
  return {
    usedPercent: Math.min(100, Math.max(0, (used / cap) * 100)),
    windowMinutes,
    resetsAt: readResetMs(record.resetAt, now),
    resetDescription: null
  }
}

/** `windowLimits.fiveHour` -> session, `windowLimits.weekly` -> weekly; weekly may omit resetAt. */
function readWindowLimits(
  payload: unknown,
  now: number
): { session: RateLimitWindow | null; weekly: RateLimitWindow | null } {
  const record = unwrap(payload)
  if (!isRecord(record) || !isRecord(record.windowLimits)) {
    return { session: null, weekly: null }
  }
  const limits = record.windowLimits
  return {
    session: isRecord(limits.fiveHour)
      ? readWindow(limits.fiveHour, SESSION_WINDOW_MINUTES, now)
      : null,
    weekly: isRecord(limits.weekly) ? readWindow(limits.weekly, WEEK_WINDOW_MINUTES, now) : null
  }
}

/** Balance is the sum of the monthly, purchased, and free credit pools. */
function readCreditBalance(payload: unknown): number | null {
  const record = unwrap(payload)
  if (!isRecord(record) || !isRecord(record.credits)) {
    return null
  }
  const credits = record.credits
  const parts = [
    finiteNumber(credits.monthlyCredits),
    finiteNumber(credits.purchasedCredits),
    finiteNumber(credits.freeCredits)
  ]
  if (parts.every((part) => part === null)) {
    return null
  }
  return parts.reduce<number>((sum, part) => sum + (part ?? 0), 0)
}

/** Plan label: `data.plan?.name`, `data.planName`, `data.metadata.plan`, then the subscription status. */
function readPlanType(payload: unknown): string | null {
  const data = unwrap(payload)
  if (!isRecord(data)) {
    return null
  }
  const candidates: unknown[] = []
  if (isRecord(data.plan)) {
    candidates.push(data.plan.name)
  } else if (typeof data.plan === 'string') {
    candidates.push(data.plan)
  }
  candidates.push(data.planName)
  if (isRecord(data.metadata)) {
    candidates.push(data.metadata.plan)
  }
  candidates.push(data.status)
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim()
    }
  }
  return null
}

export function normalizeCommandCodeUsage(input: {
  credits: unknown
  subscriptions: unknown
  now: number
}): CommandCodeUsageNormalized {
  const { session, weekly } = readWindowLimits(input.credits, input.now)
  const balance = readCreditBalance(input.credits)
  return {
    session,
    weekly,
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
