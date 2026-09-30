import type { RateLimitWindow } from '../../shared/rate-limit-types'

// Command Code CLI 1.66.0 plan IDs; current public allowances: commandcode.ai/docs/resources/pricing-limits.
const PLANS = new Map<string, { name: string; credits: number }>([
  ['individual-go', { name: 'Go', credits: 10 }],
  ['individual-goat', { name: 'GOAT', credits: 70 }],
  ['individual-pro', { name: 'Pro (legacy)', credits: 30 }],
  ['individual-pro-v1', { name: 'Pro', credits: 80 }],
  ['individual-max', { name: 'Max', credits: 150 }],
  ['individual-ultra', { name: 'Ultra', credits: 300 }]
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Estimates only a known individual plan's included credits, excluding purchased/free pools. */
export function estimateCommandCodeMonthlyUsage(
  subscription: unknown,
  monthlyRemaining: unknown,
  now = Date.now()
): { planType: string | null; monthly: RateLimitWindow | null } {
  const empty = { planType: null, monthly: null }
  if (!isRecord(subscription) || subscription.success !== true || !isRecord(subscription.data)) {
    return empty
  }
  const data = subscription.data
  const plan = typeof data.planId === 'string' ? PLANS.get(data.planId) : undefined
  if (!plan) {
    return empty
  }
  const planOnly = { planType: plan.name, monthly: null }
  if (
    data.status !== 'active' ||
    data.orgId != null ||
    data.quantity !== 1 ||
    typeof monthlyRemaining !== 'number' ||
    !Number.isFinite(monthlyRemaining) ||
    monthlyRemaining < 0 ||
    monthlyRemaining > plan.credits ||
    typeof data.currentPeriodStart !== 'string' ||
    typeof data.currentPeriodEnd !== 'string'
  ) {
    return planOnly
  }
  const start = Date.parse(data.currentPeriodStart)
  const end = Date.parse(data.currentPeriodEnd)
  const duration = end - start
  // Annual, expired, and promotional allocations need a server-provided allowance.
  if (
    !Number.isFinite(duration) ||
    start > now ||
    end <= now ||
    duration < 27 * 86_400_000 ||
    duration > 32 * 86_400_000
  ) {
    return planOnly
  }
  return {
    planType: plan.name,
    monthly: {
      usedPercent: (1 - monthlyRemaining / plan.credits) * 100,
      windowMinutes: Math.round(duration / 60_000),
      resetsAt: end,
      resetDescription: null,
      estimated: true
    }
  }
}
