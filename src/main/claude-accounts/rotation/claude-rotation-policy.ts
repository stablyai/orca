import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import type {
  ClaudeAccountRotationLimit,
  ClaudeAccountRotationSettings
} from '../../../shared/agent-accounts/claude/claude-account-rotation'

// Timings mirror the external claude_rotate.py defaults so both behave alike.
export const ROTATION_TIMING = {
  cycleMs: 60_000,
  checkGapMs: 55_000,
  minSwapGapMs: 600_000,
  alertGapMs: 1_800_000,
  lockWaitMs: 12_000,
  metaLockWaitMs: 8_000,
  verifyAfterMs: 40_000,
  verifyGiveUpMs: 900_000,
  preferCheckGapMs: 300_000,
  rateLimitedBackoffMs: 300_000,
  tokenAccountCacheMs: 2 * 86_400_000
} as const

export const PREFER_RETURN_FIVE_PERCENT = 50
export const RESET_MIN_LEAD_MS = 3_600_000
export const RESET_RETURN_WEEK_ROOM = 2

export type RotationUsage = {
  five: number
  fiveResetsAt: number | null
  /** The highest weekly window, model-scoped ones included. */
  week: number
  weekResetsAt: number | null
  /** The all-models weekly reset, which orders accounts in 'reset' mode. */
  weekAllResetsAt: number | null
}

export type RotationUsageRecord = RotationUsage & { checkedAt: number }

export function rotationUsageFromRateLimits(limits: ProviderRateLimits): RotationUsage {
  const weekly = limits.weekly
  const fable = limits.fableWeekly
  const top = fable && (!weekly || fable.usedPercent > weekly.usedPercent) ? fable : weekly
  return {
    five: limits.session?.usedPercent ?? 0,
    fiveResetsAt: limits.session?.resetsAt ?? null,
    week: top?.usedPercent ?? 0,
    weekResetsAt: top?.resetsAt ?? null,
    weekAllResetsAt: weekly?.resetsAt ?? null
  }
}

export type RotationOverReason = ClaudeAccountRotationLimit

export function overReasons(
  usage: RotationUsage,
  settings: Pick<ClaudeAccountRotationSettings, 'fiveHourPercent' | 'weeklyPercent'>
): RotationOverReason[] {
  const reasons: RotationOverReason[] = []
  if (usage.five >= settings.fiveHourPercent) {
    reasons.push({ window: 'five-hour', percent: Math.round(usage.five) })
  }
  if (usage.week >= settings.weeklyPercent) {
    reasons.push({ window: 'weekly', percent: Math.round(usage.week) })
  }
  return reasons
}

export function describeOverReasons(reasons: RotationOverReason[]): string {
  return reasons
    .map((reason) => `${reason.window === 'five-hour' ? '5-hour' : 'weekly'} ${reason.percent}%`)
    .join(', ')
}

/** A stored reading counts as zero once its window has reset. */
export function effectiveUsage(record: RotationUsageRecord, now: number): RotationUsage {
  const age = now - record.checkedAt
  const fiveReset = record.fiveResetsAt !== null ? record.fiveResetsAt <= now : age > 5 * 3_600_000
  const weekReset = record.weekResetsAt !== null ? record.weekResetsAt <= now : age > 7 * 86_400_000
  return {
    five: fiveReset ? 0 : record.five,
    fiveResetsAt: record.fiveResetsAt,
    week: weekReset ? 0 : record.week,
    weekResetsAt: record.weekResetsAt,
    weekAllResetsAt: record.weekAllResetsAt
  }
}

/** Position in the preferred list; unlisted accounts sort after every listed one. */
export function preferRank(preferred: string[], account: string | null): number {
  if (account) {
    const index = preferred.findIndex(
      (entry) => account.startsWith(entry) || entry.startsWith(account)
    )
    if (index !== -1) {
      return index
    }
  }
  return preferred.length
}

/** The upcoming weekly reset; null when unknown or already past. */
export function upcomingWeekReset(usage: RotationUsage | null, now: number): number | null {
  for (const at of [usage?.weekAllResetsAt, usage?.weekResetsAt]) {
    if (typeof at === 'number' && at > now) {
      return at
    }
  }
  return null
}

export type RotationCandidate = {
  accountId: string
  claudeAccount: string
  /** Usage was read just now or from a stored reading. */
  known: boolean
  /** Usage was read from the server during this check. */
  live: boolean
  usage: RotationUsage | null
}

function orderKey(
  candidate: RotationCandidate,
  settings: ClaudeAccountRotationSettings,
  now: number
): number[] {
  const usage = candidate.usage
  const key = [candidate.known ? 0 : 1]
  if (settings.order === 'reset') {
    key.push(upcomingWeekReset(usage, now) ?? Number.POSITIVE_INFINITY)
  }
  key.push(
    preferRank(settings.preferredAccounts, candidate.claudeAccount),
    usage?.week ?? 0,
    usage?.five ?? 0
  )
  return key
}

export function sortCandidates(
  candidates: RotationCandidate[],
  settings: ClaudeAccountRotationSettings,
  now: number
): RotationCandidate[] {
  const keyed = candidates.map((candidate) => ({
    candidate,
    key: orderKey(candidate, settings, now)
  }))
  keyed.sort((a, b) => {
    for (let i = 0; i < a.key.length; i += 1) {
      if (a.key[i] !== b.key[i]) {
        return a.key[i] < b.key[i] ? -1 : 1
      }
    }
    return 0
  })
  return keyed.map((entry) => entry.candidate)
}

export type RotationReturnRule = {
  /** Pre-filters by stored readings so the server is asked about fewer accounts. */
  wants: (claudeAccount: string, stored: RotationUsageRecord | undefined) => boolean
  /** Picks among the sorted candidates; null keeps the current account. */
  choose: (sorted: RotationCandidate[]) => RotationCandidate | null
}

/** When to switch back while under the limits: to a preferred account, or a sooner weekly reset. */
export function returnRule(
  settings: ClaudeAccountRotationSettings,
  current: { claudeAccount: string | null; usage: RotationUsage },
  now: number
): RotationReturnRule | null {
  if (settings.order === 'reset') {
    const mine = upcomingWeekReset(current.usage, now)
    const sooner = (at: number | null): boolean =>
      at !== null && (mine === null || at <= mine - RESET_MIN_LEAD_MS)
    return {
      wants: (_, stored) =>
        stored !== undefined &&
        sooner(upcomingWeekReset(stored, now)) &&
        overReasons(effectiveUsage(stored, now), settings).length === 0,
      choose: (sorted) =>
        sorted.find(
          (candidate) =>
            candidate.known &&
            sooner(upcomingWeekReset(candidate.usage, now)) &&
            (candidate.usage?.five ?? 0) <= PREFER_RETURN_FIVE_PERCENT &&
            (candidate.usage?.week ?? 0) <= settings.weeklyPercent - RESET_RETURN_WEEK_ROOM
        ) ?? null
    }
  }
  const mine = preferRank(settings.preferredAccounts, current.claudeAccount)
  if (mine === 0) {
    return null
  }
  return {
    wants: (account) => preferRank(settings.preferredAccounts, account) < mine,
    choose: (sorted) =>
      sorted.find(
        (candidate) => candidate.known && (candidate.usage?.five ?? 0) <= PREFER_RETURN_FIVE_PERCENT
      ) ?? null
  }
}
