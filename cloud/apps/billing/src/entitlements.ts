// "Can this account start a sandbox, and how many hours are left?" One computation shared by the
// desktop endpoint and the control plane's start check, so the two can never disagree.
import { MACHINE_SIZES, includedSeconds, overageCapSeconds, planCatalog, type MachineSize, type PlanId } from './plans'
import type { Env } from './env'
import { currentSubscription, periodUsage } from './store'

export type DenyReason =
  | 'no_subscription'
  | 'subscription_inactive'
  | 'payment_past_due'
  | 'included_hours_exhausted'
  | 'overage_cap_reached'
  | 'machine_size_not_in_plan'
  | 'concurrency_limit'

export type Entitlement = {
  accountId: string
  plan: PlanId | null
  planLabel: string | null
  status: string
  seats: number
  period: { start: number; end: number } | null
  cancelAtPeriodEnd: boolean
  includedSeconds: number
  usedSeconds: number
  remainingIncludedSeconds: number
  overageSeconds: number
  overageEnabled: boolean
  overageCapSeconds: number
  limits: { maxConcurrentSandboxes: number; machineSizes: readonly MachineSize[] }
  canStartSandbox: boolean
  reason: DenyReason | null
}

const LIVE_STATUSES = new Set(['active', 'trialing'])

export async function computeEntitlement(env: Pick<Env, 'BILLING_DB' | 'BILLING_PLANS'>, accountId: string): Promise<Entitlement> {
  const db = env.BILLING_DB
  const catalog = planCatalog(env)
  const subscription = await currentSubscription(db, accountId)
  if (!subscription) {
    return {
      accountId,
      plan: null,
      planLabel: null,
      status: 'none',
      seats: 0,
      period: null,
      cancelAtPeriodEnd: false,
      includedSeconds: 0,
      usedSeconds: 0,
      remainingIncludedSeconds: 0,
      overageSeconds: 0,
      overageEnabled: false,
      overageCapSeconds: 0,
      limits: { maxConcurrentSandboxes: 0, machineSizes: [] },
      canStartSandbox: false,
      reason: 'no_subscription'
    }
  }
  const plan = catalog[subscription.plan]
  const included = includedSeconds(plan, subscription.seats)
  const cap = overageCapSeconds(plan, subscription.seats)
  const usage = await periodUsage(db, accountId, subscription.current_period_start)
  const remaining = Math.max(0, included - usage.usedSeconds)
  const overageEnabled = subscription.overage_enabled === 1

  let reason: DenyReason | null = null
  if (subscription.status === 'past_due') {
    // Stripe is retrying the card; running sandboxes are left to the control plane, new starts wait.
    reason = 'payment_past_due'
  } else if (!LIVE_STATUSES.has(subscription.status)) {
    reason = 'subscription_inactive'
  } else if (remaining === 0 && !overageEnabled) {
    reason = 'included_hours_exhausted'
  } else if (remaining === 0 && usage.overageSeconds >= cap) {
    reason = 'overage_cap_reached'
  }

  return {
    accountId,
    plan: subscription.plan,
    planLabel: plan.label,
    status: subscription.status,
    seats: subscription.seats,
    period: { start: subscription.current_period_start, end: subscription.current_period_end },
    cancelAtPeriodEnd: subscription.cancel_at_period_end === 1,
    includedSeconds: included,
    usedSeconds: usage.usedSeconds,
    remainingIncludedSeconds: remaining,
    overageSeconds: usage.overageSeconds,
    overageEnabled,
    overageCapSeconds: cap,
    limits: { maxConcurrentSandboxes: plan.maxConcurrentSandboxes, machineSizes: plan.machineSizes },
    canStartSandbox: reason === null,
    reason
  }
}

export function isMachineSize(value: unknown): value is MachineSize {
  return typeof value === 'string' && (MACHINE_SIZES as readonly string[]).includes(value)
}

/** The control plane's start gate: the account-level answer plus size and concurrency. */
export function checkStart(
  entitlement: Entitlement,
  request: { machineSize: MachineSize; runningSandboxes: number }
): { allow: boolean; reason: DenyReason | null } {
  if (!entitlement.canStartSandbox) {
    return { allow: false, reason: entitlement.reason }
  }
  if (!entitlement.limits.machineSizes.includes(request.machineSize)) {
    return { allow: false, reason: 'machine_size_not_in_plan' }
  }
  if (request.runningSandboxes >= entitlement.limits.maxConcurrentSandboxes) {
    return { allow: false, reason: 'concurrency_limit' }
  }
  return { allow: true, reason: null }
}
