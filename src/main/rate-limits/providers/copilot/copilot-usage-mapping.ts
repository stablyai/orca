import {
  COPILOT_AIC_BUCKET_NAME,
  COPILOT_CHAT_BUCKET_NAME,
  COPILOT_COMPLETIONS_BUCKET_NAME
} from '../../../../shared/agent-usage/rate-limits/copilot-usage-buckets'
import type { RateLimitBucket } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'

// Copilot quota resets on a calendar date; other monthly meters use the same nominal length.
const MONTHLY_WINDOW_MINUTES = 43_200

const SNAPSHOTS = [
  ['premium_interactions', COPILOT_AIC_BUCKET_NAME],
  ['chat', COPILOT_CHAT_BUCKET_NAME],
  ['completions', COPILOT_COMPLETIONS_BUCKET_NAME]
] as const

export type CopilotUsageMapping = {
  planType: string | null
  buckets: RateLimitBucket[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function remainingOf(snapshot: Record<string, unknown>): number | null {
  const remaining = finiteNumber(snapshot.remaining)
  return remaining !== null ? remaining : finiteNumber(snapshot.quota_remaining)
}

/** An empty premium pool is absent; a used-up pool with a real entitlement stays. */
function shouldSkipSnapshot(snapshot: Record<string, unknown>): boolean {
  return (
    finiteNumber(snapshot.entitlement) === 0 &&
    snapshot.unlimited !== true &&
    remainingOf(snapshot) === 0
  )
}

function usedPercentOf(snapshot: Record<string, unknown>): number | null {
  const percentRemaining = finiteNumber(snapshot.percent_remaining)
  if (percentRemaining !== null) {
    return clampPercent(100 - percentRemaining)
  }
  // No remaining percent: an unlimited pool has nothing consumed against a cap.
  if (snapshot.unlimited === true) {
    return 0
  }
  const entitlement = finiteNumber(snapshot.entitlement)
  const remaining = remainingOf(snapshot)
  if (entitlement === null || entitlement <= 0 || remaining === null) {
    return null
  }
  return clampPercent(((entitlement - remaining) / entitlement) * 100)
}

function resetAtMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const parsed = Date.parse(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

function resetDescription(resetsAt: number | null): string | null {
  if (resetsAt === null) {
    return null
  }
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function planTypeOf(payload: Record<string, unknown>): string | null {
  for (const key of ['plan', 'copilot_plan'] as const) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return null
}

/** Maps `gh api /copilot_internal/user` quota fields. Anything else is unreadable. */
export function mapCopilotUsagePayload(payload: unknown): CopilotUsageMapping | null {
  if (!isRecord(payload) || !isRecord(payload.quota_snapshots)) {
    return null
  }
  const resetsAt = resetAtMs(payload.quota_reset_date)
  const description = resetDescription(resetsAt)
  const buckets: RateLimitBucket[] = []
  for (const [key, name] of SNAPSHOTS) {
    const snapshot = payload.quota_snapshots[key]
    if (!isRecord(snapshot) || shouldSkipSnapshot(snapshot)) {
      continue
    }
    const usedPercent = usedPercentOf(snapshot)
    if (usedPercent === null) {
      continue
    }
    buckets.push({
      name,
      usedPercent,
      windowMinutes: MONTHLY_WINDOW_MINUTES,
      resetsAt,
      resetDescription: description
    })
  }
  return { planType: planTypeOf(payload), buckets }
}
