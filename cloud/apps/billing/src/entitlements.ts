// "Can this account start a sandbox, and how many hours are left?" One computation shared by the
// desktop endpoint and the control plane's start check, so the two can never disagree.
import type { Env } from './env'
import {
  MACHINE_SIZES,
  allowanceWindow,
  capSeconds,
  includedSeconds,
  planCatalog,
  type BillingInterval,
  type MachineSize,
  type PlanId
} from './plans'
import { accountSettings, currentSubscription, meteredSeconds, periodUsage, type SubscriptionRow } from './store'

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
  interval: BillingInterval | null
  seats: number
  /** Billing period (a year for annual plans). */
  period: { start: number; end: number } | null
  /** Monthly allowance window the hours below count against. */
  usageWindow: { start: number; end: number } | null
  cancelAtPeriodEnd: boolean
  includedSeconds: number
  usedSeconds: number
  remainingIncludedSeconds: number
  /** Highest configured warning level reached (e.g. 80, 100), or null. */
  usageWarningPercent: number | null
  overageSeconds: number
  overage: {
    optedIn: boolean
    /** Opted in and the metered item is on the subscription: overage is being billed. */
    active: boolean
    spendCapCents: number
    spentCents: number
    centsPerHour: number
  }
  limits: { maxConcurrentSandboxes: number; machineSizes: readonly MachineSize[]; idleSleepMinutes: number }
  canStartSandbox: boolean
  reason: DenyReason | null
}

const LIVE_STATUSES = new Set(['active', 'trialing'])

export function subscriptionWindow(subscription: SubscriptionRow, at: number): { start: number; end: number } {
  return allowanceWindow({ start: subscription.current_period_start, end: subscription.current_period_end }, at)
}

export async function computeEntitlement(
  env: Pick<Env, 'BILLING_DB' | 'BILLING_PLANS'>,
  accountId: string,
  now: number = Date.now()
): Promise<Entitlement> {
  const db = env.BILLING_DB
  const team = planCatalog(env).team
  const [subscription, settings] = await Promise.all([currentSubscription(db, accountId), accountSettings(db, accountId)])
  const spendCapCents = settings.spend_cap_cents ?? team.defaultSpendCapCents
  const overageBase = { optedIn: settings.overage_opt_in === 1, spendCapCents, centsPerHour: team.overageCentsPerHour }
  if (!subscription) {
    return {
      accountId,
      plan: null,
      planLabel: null,
      status: 'none',
      interval: null,
      seats: 0,
      period: null,
      usageWindow: null,
      cancelAtPeriodEnd: false,
      includedSeconds: 0,
      usedSeconds: 0,
      remainingIncludedSeconds: 0,
      usageWarningPercent: null,
      overageSeconds: 0,
      overage: { ...overageBase, active: false, spentCents: 0 },
      limits: { maxConcurrentSandboxes: 0, machineSizes: [], idleSleepMinutes: team.idleSleepMinutes },
      canStartSandbox: false,
      reason: 'no_subscription'
    }
  }
  const window = subscriptionWindow(subscription, now)
  const included = includedSeconds(team, subscription.seats)
  const [usage, metered] = await Promise.all([
    periodUsage(db, accountId, window.start),
    meteredSeconds(db, accountId, window.start)
  ])
  const remaining = Math.max(0, included - usage.usedSeconds)
  const overageActive = overageBase.optedIn && subscription.overage_item_id !== null
  const usedPercent = included > 0 ? (usage.usedSeconds / included) * 100 : 0
  const warnings = team.warnAtPercent.filter((level) => usedPercent >= level)

  let reason: DenyReason | null = null
  if (subscription.status === 'past_due') {
    // Stripe is retrying the card; running sandboxes are left to the control plane, new starts wait.
    reason = 'payment_past_due'
  } else if (!LIVE_STATUSES.has(subscription.status)) {
    reason = 'subscription_inactive'
  } else if (remaining === 0 && !overageActive) {
    reason = 'included_hours_exhausted'
  } else if (remaining === 0 && metered >= capSeconds(team, spendCapCents)) {
    reason = 'overage_cap_reached'
  }

  return {
    accountId,
    plan: subscription.plan,
    planLabel: team.label,
    status: subscription.status,
    interval: subscription.billing_interval,
    seats: subscription.seats,
    period: { start: subscription.current_period_start, end: subscription.current_period_end },
    usageWindow: window,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === 1,
    includedSeconds: included,
    usedSeconds: usage.usedSeconds,
    remainingIncludedSeconds: remaining,
    usageWarningPercent: warnings.length > 0 ? Math.max(...warnings) : null,
    overageSeconds: usage.overageSeconds,
    overage: {
      ...overageBase,
      active: overageActive,
      spentCents: Math.round((metered / 3600) * team.overageCentsPerHour)
    },
    limits: {
      maxConcurrentSandboxes: team.concurrentSandboxesPerSeat * Math.max(1, subscription.seats),
      machineSizes: team.machineSizes,
      idleSleepMinutes: team.idleSleepMinutes
    },
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
