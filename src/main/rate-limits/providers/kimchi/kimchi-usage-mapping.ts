import type { RateLimitWindow } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'

const DEFAULT_MONTHLY_WINDOW_MINUTES = 30 * 24 * 60

export type KimchiUsageMapping =
  | { kind: 'ok'; monthly: RateLimitWindow; planType: string | null }
  | { kind: 'unavailable' }
  | { kind: 'parse' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decimalValue(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return 0
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function monthlyWindow(
  usedPercent: number,
  period: Record<string, unknown> | undefined
): RateLimitWindow {
  const startedAt = timestamp(period?.startTime)
  const endedAt = timestamp(period?.endTime)
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowMinutes:
      startedAt !== null && endedAt !== null && endedAt > startedAt
        ? Math.max(1, Math.round((endedAt - startedAt) / 60_000))
        : DEFAULT_MONTHLY_WINDOW_MINUTES,
    resetsAt: endedAt,
    resetDescription: null
  }
}

/** Matches Kimchi getDisplayBudget: independent capped scopes use the highest monthly usage. */
export function mapKimchiUserBudget(payload: unknown): KimchiUsageMapping {
  if (!isRecord(payload) || !Array.isArray(payload.budgets)) {
    return { kind: 'parse' }
  }
  const period = isRecord(payload.period) ? payload.period : undefined
  let selected: { usedPercent: number; planType: string | null } | null = null
  for (const entry of payload.budgets) {
    if (!isRecord(entry)) {
      return { kind: 'parse' }
    }
    const limit = decimalValue(entry.budgetLimitUsd)
    const spend = decimalValue(entry.totalSpendUsd)
    if (limit === null || spend === null || limit < 0) {
      return { kind: 'parse' }
    }
    if (limit === 0) {
      continue
    }
    const usedPercent = (spend / limit) * 100
    if (!selected || usedPercent > selected.usedPercent) {
      selected = {
        usedPercent,
        planType: typeof entry.scope === 'string' && entry.scope ? entry.scope.toLowerCase() : null
      }
    }
  }
  return selected
    ? {
        kind: 'ok',
        monthly: monthlyWindow(selected.usedPercent, period),
        planType: selected.planType
      }
    : { kind: 'unavailable' }
}
