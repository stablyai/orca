// "Can this account start a sandbox, and how many hours are left?" One computation shared by the
// desktop endpoint and the control plane's start check, so the two can never disagree.
//
// The answer has two halves: the account's Stripe/trial STATE (subscription mirror, payment grace,
// usage in the window) and its TERMS (hours, concurrency, sizes, overage, policy). Terms come from
// one of two sources, chosen by ENTITLEMENTS_MODE (env.ts):
// - legacy: the static plan catalog (plans.ts DEFAULT_PLANS + BILLING_PLANS, trial constants);
// - grants: the D1 catalog + the account's entitlement grants (catalog.ts, grants.ts).
// In 'shadow' both are computed, legacy is served and any difference is recorded.
import type { Env } from './env'
import {
  MACHINE_SIZES,
  allowanceWindow,
  capSeconds,
  includedSeconds,
  overageCents,
  planCatalog,
  type BillingInterval,
  type MachineSize,
  type PlanId
} from './plans'
import { accountSettings, currentSubscription, meteredSeconds, periodUsage, type AccountSettings, type SubscriptionRow } from './store'
import { PAYMENT_FAILED_STATUSES } from './webhook'
import { TRIAL_MAX_CONCURRENT_SANDBOXES, trialRow, trialState, type TrialRow, type TrialState } from './trial'
import { ORCA_CLOUD_OVERAGE_CENTS_PER_HOUR } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { CatalogUnavailableError, loadCatalog, planVersion, policyFor, type Catalog, type PlanPolicy } from './catalog'
import { aggregateGrants, isEntitlementKey, type GrantValue } from './entitlement-keys'
import { entitlementsMode } from './entitlements-mode'
import { grantsForSubject, liveAt, projectSubscription, projectTrial, type GrantRow } from './grants'

export type DenyReason =
  | 'no_subscription'
  | 'subscription_inactive'
  | 'payment_past_due'
  | 'payment_grace_expired'
  | 'included_hours_exhausted'
  | 'overage_cap_reached'
  | 'machine_size_not_in_plan'
  | 'concurrency_limit'
  | 'member_concurrency_limit'
  // One-time trial (trial.ts): its sandbox hours are used up, or this team can't have one.
  | 'trial_used_up'
  | 'trial_unavailable'

export type Entitlement = {
  accountId: string
  plan: PlanId | null
  planLabel: string | null
  status: string
  interval: BillingInterval | null
  seats: number
  /** Latest org member count from auth; seats stay at the period's peak until renewal. */
  members: number | null
  /** When seats will come down to the member count at renewal. */
  seatChange: { seatsAtRenewal: number; effectiveAt: number } | null
  /** Billing period (a year for annual plans). */
  period: { start: number; end: number } | null
  /** Monthly allowance window the hours below count against. */
  usageWindow: { start: number; end: number } | null
  cancelAtPeriodEnd: boolean
  /**
   * The one-time trial while it is the account's plan (no subscription ever). Null otherwise: a
   * subscription ends the trial for good. includedSeconds/usedSeconds below mirror it during a trial.
   */
  trial: TrialState | null
  includedSeconds: number
  usedSeconds: number
  remainingIncludedSeconds: number
  /** Highest configured warning level reached (75, 90 or 100), or null. */
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
  limits: {
    maxConcurrentSandboxes: number
    /** Per member, so one seat cannot run the whole team's sandboxes. */
    maxConcurrentSandboxesPerMember: number
    machineSizes: readonly MachineSize[]
    idleSleepMinutes: number
  }
  /** Failed payment: new starts stop at once; running sandboxes must be suspended after the grace. */
  payment: { pastDueSince: number | null; graceEndsAt: number | null; suspendRunning: boolean }
  /**
   * The account's running sandboxes must go to sleep now (snapshot kept, never deleted): payment
   * grace expired, or the account is at its limit (out of included hours with overage off, or at
   * its overage spend cap). The control plane acts on it from the start check and usage reports.
   */
  suspendRunning: boolean
  canStartSandbox: boolean
  reason: DenyReason | null
}

/** What the account's plan (or trial) gives it, whichever source the numbers come from. */
export type AccountTerms = {
  planLabel: string | null
  /** The window's included seconds (subscription), or the trial's lifetime seconds. */
  includedSeconds: number
  maxConcurrentSandboxes: number
  maxConcurrentSandboxesPerMember: number
  machineSizes: readonly MachineSize[]
  overageAllowed: boolean
  /** The subscription is live in Stripe but no grant backs it (grants mode only): deny. */
  ungranted: boolean
  warnAtPercent: readonly number[]
  paymentGraceHours: number
  defaultSpendCapCents: number
  maxSpendCapCents: number
  overageCentsPerHour: number
  idleSleepMinutes: number
}

type AccountState = {
  accountId: string
  subscription: SubscriptionRow | null
  settings: AccountSettings
  /** Loaded only when there is no subscription (a subscription ends the trial). */
  trial: TrialRow | null
}

export { entitlementsMode, type EntitlementsMode } from './entitlements-mode'

const LIVE_STATUSES = new Set(['active', 'trialing'])

export function subscriptionWindow(subscription: SubscriptionRow, at: number): { start: number; end: number } {
  return allowanceWindow({ start: subscription.current_period_start, end: subscription.current_period_end }, at)
}

type EntitlementEnv = Pick<Env, 'BILLING_DB' | 'BILLING_PLANS' | 'ENTITLEMENTS_MODE'>

async function loadState(db: D1Database, accountId: string): Promise<AccountState> {
  const [subscription, settings] = await Promise.all([currentSubscription(db, accountId), accountSettings(db, accountId)])
  return { accountId, subscription, settings, trial: subscription ? null : await trialRow(db, accountId) }
}

// ---------------------------------------------------------------------------------------------
// Terms: legacy (static catalog) and grants (D1 catalog + grants)

function legacyTerms(env: Pick<Env, 'BILLING_PLANS'>, state: AccountState): AccountTerms {
  const team = planCatalog(env).team
  const shared = {
    warnAtPercent: team.warnAtPercent,
    paymentGraceHours: team.paymentGraceHours,
    defaultSpendCapCents: team.defaultSpendCapCents,
    maxSpendCapCents: team.maxSpendCapCents,
    overageCentsPerHour: team.overageCentsPerHour,
    idleSleepMinutes: team.idleSleepMinutes,
    ungranted: false
  }
  if (state.subscription) {
    const seats = Math.max(1, state.subscription.seats)
    return {
      ...shared,
      planLabel: team.label,
      includedSeconds: includedSeconds(team, state.subscription.seats),
      maxConcurrentSandboxes: team.concurrentSandboxesPerSeat * seats,
      maxConcurrentSandboxesPerMember: team.concurrentSandboxesPerSeat,
      machineSizes: team.machineSizes,
      overageAllowed: true
    }
  }
  if (state.trial && state.trial.revoked_at === null) {
    return {
      ...shared,
      planLabel: null,
      includedSeconds: state.trial.included_seconds,
      maxConcurrentSandboxes: TRIAL_MAX_CONCURRENT_SANDBOXES,
      maxConcurrentSandboxesPerMember: TRIAL_MAX_CONCURRENT_SANDBOXES,
      machineSizes: team.machineSizes,
      overageAllowed: false
    }
  }
  return { ...shared, planLabel: null, includedSeconds: 0, maxConcurrentSandboxes: 0, maxConcurrentSandboxesPerMember: 0, machineSizes: [], overageAllowed: false }
}

/** The overage rate: the Stripe overage price the catalog synced, else the shared constant. */
export function catalogOverageCentsPerHour(catalog: Catalog, planId: string | null): number {
  const price = catalog.prices.find(
    (row) => row.role === 'overage' && row.is_checkout_price === 1 && row.active === 1 && (planId === null || row.plan_id === planId)
  )
  const perMinute = price?.unit_amount_decimal ? Number(price.unit_amount_decimal) : NaN
  // Per-minute price (cents) x 60, rounded to whole cents per hour (the rate is set in cents per hour).
  return Number.isFinite(perMinute) && perMinute > 0 ? Math.round(perMinute * 60) : ORCA_CLOUD_OVERAGE_CENTS_PER_HOUR
}

/**
 * Re-projects the account's subscription/trial grants when they are missing or older than the
 * Stripe mirror (a write path that skipped projection, or rows from before 0008). Idempotent.
 */
async function ensureProjected(db: D1Database, catalog: Catalog, state: AccountState, grants: GrantRow[], now: number): Promise<GrantRow[]> {
  let changed = false
  const subscription = state.subscription
  if (subscription) {
    const own = grants.filter((row) => row.source_type === 'subscription' && row.source_id === subscription.stripe_subscription_id)
    if (own.length === 0 || own.every((row) => row.source_synced_at < subscription.updated_at)) {
      changed = (await projectSubscription(db, catalog, subscription, now, 'lazy')).changed || changed
    }
    // A trial the subscription ended: revoke it now rather than leave live trial rows behind.
    if (grants.some((row) => row.source_type === 'trial' && row.state !== 'revoked')) {
      const trial = await trialRow(db, state.accountId)
      if (trial) {
        changed = (await projectTrial(db, catalog, trial, true, now, 'lazy')).changed || changed
      }
    }
  } else if (state.trial) {
    const own = grants.filter((row) => row.source_type === 'trial')
    const stale = own.length === 0 || (state.trial.revoked_at !== null && own.some((row) => row.state !== 'revoked'))
    if (stale) {
      changed = (await projectTrial(db, catalog, state.trial, false, now, 'lazy')).changed || changed
    }
  }
  return changed ? grantsForSubject(db, state.accountId) : grants
}

function grantValue(row: GrantRow): GrantValue | null {
  if (!isEntitlementKey(row.entitlement_key)) {
    return null
  }
  return { key: row.entitlement_key, value: JSON.parse(row.value_json), perSeat: row.per_seat === 1, seats: row.seat_quantity }
}

async function grantTerms(env: EntitlementEnv, state: AccountState, now: number): Promise<AccountTerms> {
  const db = env.BILLING_DB
  const catalog = await loadCatalog(db, now)
  const grants = await ensureProjected(db, catalog, state, await grantsForSubject(db, state.accountId), now)
  const manual = grants.filter((row) => (row.source_type === 'manual' || row.source_type === 'promo') && liveAt(row, now))
  const subscription = state.subscription
  let planLabel: string | null = null
  let policy: PlanPolicy
  let sources: GrantRow[] = []
  let ungranted = false
  let overagePlan: string | null = null
  if (subscription) {
    // Only the current subscription's grants: its window is the one usage counts against. Held
    // and revoked rows still describe the plan (what a lapsed plan included); access is decided
    // from the Stripe state below, plus `ungranted` when nothing live backs a live subscription.
    sources = grants.filter((row) => row.source_type === 'subscription' && row.source_id === subscription.stripe_subscription_id)
    ungranted = LIVE_STATUSES.has(subscription.status) && !sources.some((row) => liveAt(row, now))
    const versionRow = sources.find((row) => row.plan_id !== null)
    const plan = catalog.plans.get(versionRow?.plan_id ?? subscription.plan) ?? null
    planLabel = plan?.name ?? null
    policy = policyFor(catalog, plan, versionRow?.plan_version ?? null)
    overagePlan = plan?.id ?? null
  } else {
    sources = grants.filter((row) => row.source_type === 'trial' && row.state !== 'revoked')
    policy = policyFor(catalog, null, null)
  }
  let planValues: GrantValue[] = sources.map(grantValue).filter((value): value is GrantValue => value !== null)
  if (subscription && sources.length === 0) {
    // A subscription that never got grants (it was already canceled or incomplete when first
    // seen): describe the plan it is on, so the lapsed plan still reads "60 h per seat". Nothing
    // is granted: access is denied by its Stripe status.
    const plan = catalog.plans.get(subscription.plan)
    if (plan) {
      planValues = Object.entries(planVersion(plan, plan.currentVersion).entitlements).flatMap(([key, entry]) =>
        entry && isEntitlementKey(key) ? [{ key, value: entry.value, perSeat: entry.perSeat, seats: Math.max(1, subscription.seats) }] : []
      )
    }
  }
  const values = aggregateGrants([...planValues, ...manual.map(grantValue).filter((value): value is GrantValue => value !== null)])
  const shared = {
    warnAtPercent: policy.warnAtPercent,
    paymentGraceHours: policy.paymentGraceHours,
    defaultSpendCapCents: policy.overage.defaultSpendCapCents,
    maxSpendCapCents: policy.overage.maxSpendCapCents,
    overageCentsPerHour: catalogOverageCentsPerHour(catalog, overagePlan),
    // Product config, not a plan term: the control plane enforces it (GET /v1/config).
    idleSleepMinutes: planCatalog(env).team.idleSleepMinutes,
    ungranted
  }
  if (subscription) {
    return {
      ...shared,
      planLabel,
      includedSeconds: values.sandboxSecondsMonthly,
      maxConcurrentSandboxes: values.maxConcurrentSandboxes,
      maxConcurrentSandboxesPerMember: values.maxConcurrentSandboxesPerMember,
      machineSizes: values.machineSizes,
      overageAllowed: values.overageAllowed
    }
  }
  return {
    ...shared,
    planLabel: null,
    includedSeconds: values.sandboxSecondsLifetime,
    maxConcurrentSandboxes: values.maxConcurrentSandboxes,
    maxConcurrentSandboxesPerMember: values.maxConcurrentSandboxesPerMember,
    machineSizes: values.machineSizes,
    overageAllowed: false
  }
}

/** The terms that apply to an account (usage metering and overage settings read these). */
export async function accountTerms(env: EntitlementEnv, accountId: string, now: number): Promise<AccountTerms> {
  const state = await loadState(env.BILLING_DB, accountId)
  return entitlementsMode(env) === 'on' ? grantTerms(env, state, now) : legacyTerms(env, state)
}

// ---------------------------------------------------------------------------------------------
// The entitlement, from state + terms

async function buildEntitlement(db: D1Database, state: AccountState, terms: AccountTerms, now: number): Promise<Entitlement> {
  const { accountId, subscription, settings } = state
  const spendCapCents = settings.spend_cap_cents ?? terms.defaultSpendCapCents
  const overageBase = { optedIn: settings.overage_opt_in === 1, spendCapCents, centsPerHour: terms.overageCentsPerHour }
  if (!subscription) {
    const trialRecord = state.trial
    if (trialRecord && trialRecord.revoked_at === null) {
      return trialEntitlement(accountId, trialState({ ...trialRecord, included_seconds: terms.includedSeconds }), terms, overageBase)
    }
    return {
      accountId,
      plan: null,
      planLabel: null,
      status: 'none',
      interval: null,
      seats: 0,
      members: null,
      seatChange: null,
      period: null,
      usageWindow: null,
      cancelAtPeriodEnd: false,
      trial: null,
      includedSeconds: 0,
      usedSeconds: 0,
      remainingIncludedSeconds: 0,
      usageWarningPercent: null,
      overageSeconds: 0,
      overage: { ...overageBase, active: false, spentCents: 0 },
      limits: {
        maxConcurrentSandboxes: 0,
        maxConcurrentSandboxesPerMember: 0,
        machineSizes: [],
        idleSleepMinutes: terms.idleSleepMinutes
      },
      payment: { pastDueSince: null, graceEndsAt: null, suspendRunning: false },
      // A revoked trial (GitHub identity reused): its running sandbox goes to sleep too.
      suspendRunning: trialRecord !== null,
      canStartSandbox: false,
      reason: trialRecord ? 'trial_unavailable' : 'no_subscription'
    }
  }
  const window = subscriptionWindow(subscription, now)
  const included = terms.includedSeconds
  const [usage, metered] = await Promise.all([periodUsage(db, accountId, window.start), meteredSeconds(db, accountId, window.start)])
  const remaining = Math.max(0, included - usage.usedSeconds)
  const overageActive = overageBase.optedIn && subscription.overage_item_id !== null && terms.overageAllowed
  const usedPercent = included > 0 ? (usage.usedSeconds / included) * 100 : 0
  const warnings = terms.warnAtPercent.filter((level) => usedPercent >= level)
  const rate = { overageCentsPerHour: terms.overageCentsPerHour }

  const pastDueSince = PAYMENT_FAILED_STATUSES.has(subscription.status) ? (subscription.past_due_since ?? now) : null
  const graceEndsAt = pastDueSince === null ? null : pastDueSince + terms.paymentGraceHours * 3600_000
  const graceExpired = graceEndsAt !== null && now >= graceEndsAt

  let reason: DenyReason | null = null
  if (graceExpired) {
    reason = 'payment_grace_expired'
  } else if (pastDueSince !== null) {
    // Stripe is retrying the card (Smart Retries + dunning emails): no new starts, running ones keep going.
    reason = 'payment_past_due'
  } else if (!LIVE_STATUSES.has(subscription.status) || terms.ungranted) {
    reason = 'subscription_inactive'
  } else if (remaining === 0 && !overageActive) {
    reason = 'included_hours_exhausted'
  } else if (remaining === 0 && metered >= capSeconds(rate, spendCapCents)) {
    reason = 'overage_cap_reached'
  }

  return {
    accountId,
    plan: subscription.plan,
    planLabel: terms.planLabel,
    status: subscription.status,
    interval: subscription.billing_interval,
    seats: subscription.seats,
    members: subscription.member_count,
    seatChange:
      subscription.member_count !== null && Math.max(1, subscription.member_count) < subscription.seats
        ? { seatsAtRenewal: Math.max(1, subscription.member_count), effectiveAt: subscription.current_period_end }
        : null,
    period: { start: subscription.current_period_start, end: subscription.current_period_end },
    usageWindow: window,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === 1,
    trial: null,
    includedSeconds: included,
    usedSeconds: usage.usedSeconds,
    remainingIncludedSeconds: remaining,
    usageWarningPercent: warnings.length > 0 ? Math.max(...warnings) : null,
    overageSeconds: usage.overageSeconds,
    overage: {
      ...overageBase,
      active: overageActive,
      // What Stripe will invoice: whole minutes at the per-minute price.
      spentCents: overageCents(rate, metered)
    },
    limits: {
      maxConcurrentSandboxes: terms.maxConcurrentSandboxes,
      maxConcurrentSandboxesPerMember: terms.maxConcurrentSandboxesPerMember,
      machineSizes: terms.machineSizes,
      idleSleepMinutes: terms.idleSleepMinutes
    },
    payment: { pastDueSince, graceEndsAt, suspendRunning: graceExpired },
    suspendRunning: graceExpired || reason === 'included_hours_exhausted' || reason === 'overage_cap_reached',
    canStartSandbox: reason === null,
    reason
  }
}

/** No card, no Stripe: the trial's hours, its concurrency, never overage. */
function trialEntitlement(
  accountId: string,
  trial: TrialState,
  terms: AccountTerms,
  overageBase: { optedIn: boolean; spendCapCents: number; centsPerHour: number }
): Entitlement {
  const usedPercent = trial.includedSeconds > 0 ? (trial.usedSeconds / trial.includedSeconds) * 100 : 100
  const warnings = terms.warnAtPercent.filter((level) => usedPercent >= level)
  const reason: DenyReason | null = trial.exhausted ? 'trial_used_up' : null
  return {
    accountId,
    plan: null,
    planLabel: null,
    status: 'trial',
    interval: null,
    seats: 0,
    members: null,
    seatChange: null,
    period: null,
    usageWindow: null,
    cancelAtPeriodEnd: false,
    trial,
    includedSeconds: trial.includedSeconds,
    usedSeconds: trial.usedSeconds,
    remainingIncludedSeconds: trial.remainingSeconds,
    usageWarningPercent: warnings.length > 0 ? Math.max(...warnings) : null,
    overageSeconds: 0,
    overage: { ...overageBase, optedIn: false, active: false, spentCents: 0 },
    limits: {
      maxConcurrentSandboxes: terms.maxConcurrentSandboxes,
      maxConcurrentSandboxesPerMember: terms.maxConcurrentSandboxesPerMember,
      machineSizes: terms.machineSizes,
      idleSleepMinutes: terms.idleSleepMinutes
    },
    payment: { pastDueSince: null, graceEndsAt: null, suspendRunning: false },
    // Used up: running sandboxes go to sleep (snapshot kept) until a plan starts.
    suspendRunning: trial.exhausted,
    canStartSandbox: reason === null,
    reason
  }
}

// ---------------------------------------------------------------------------------------------
// Shadow comparison

/** Leaf paths where two entitlements differ ("limits.maxConcurrentSandboxes: 3 != 1"). */
export function diffEntitlements(a: unknown, b: unknown, path = ''): string[] {
  if (Object.is(a, b)) {
    return []
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].flatMap((key) =>
      diffEntitlements((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], path ? `${path}.${key}` : key)
    )
  }
  return [`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`]
}

async function recordShadowDiff(db: D1Database, accountId: string, surface: string, diff: string[], now: number): Promise<void> {
  console.log(JSON.stringify({ event: 'entitlements_shadow_diff', accountId, surface, diff: diff.slice(0, 20) }))
  await db
    .prepare('INSERT INTO entitlement_shadow_diffs (account_id, surface, diff_json, at) VALUES (?1, ?2, ?3, ?4)')
    .bind(accountId, surface, JSON.stringify(diff.slice(0, 50)), now)
    .run()
    .catch(() => undefined)
}

export async function computeEntitlement(
  env: EntitlementEnv,
  accountId: string,
  now: number = Date.now(),
  surface = 'entitlement'
): Promise<Entitlement> {
  const db = env.BILLING_DB
  const state = await loadState(db, accountId)
  const mode = entitlementsMode(env)
  if (mode === 'on') {
    return buildEntitlement(db, state, await grantTerms(env, state, now), now)
  }
  const legacy = await buildEntitlement(db, state, legacyTerms(env, state), now)
  if (mode === 'shadow') {
    try {
      const resolved = await buildEntitlement(db, state, await grantTerms(env, state, now), now)
      const diff = diffEntitlements(legacy, resolved)
      if (diff.length > 0) {
        await recordShadowDiff(db, accountId, surface, diff, now)
      }
    } catch (error) {
      const message = error instanceof CatalogUnavailableError ? error.message : error instanceof Error ? `${error.name}: ${error.message.slice(0, 160)}` : 'unknown'
      await recordShadowDiff(db, accountId, surface, [`resolver_error: ${message}`], now)
    }
  }
  return legacy
}

export function isMachineSize(value: unknown): value is MachineSize {
  return typeof value === 'string' && (MACHINE_SIZES as readonly string[]).includes(value)
}

/** The control plane's start gate: the account-level answer plus size and concurrency. */
export function checkStart(
  entitlement: Entitlement,
  request: { machineSize: MachineSize; runningSandboxes: number; runningSandboxesForUser?: number }
): { allow: boolean; reason: DenyReason | null; suspendRunning: boolean } {
  const suspendRunning = entitlement.suspendRunning
  if (!entitlement.canStartSandbox) {
    return { allow: false, reason: entitlement.reason, suspendRunning }
  }
  if (!entitlement.limits.machineSizes.includes(request.machineSize)) {
    return { allow: false, reason: 'machine_size_not_in_plan', suspendRunning }
  }
  if (request.runningSandboxes >= entitlement.limits.maxConcurrentSandboxes) {
    return { allow: false, reason: 'concurrency_limit', suspendRunning }
  }
  if (
    request.runningSandboxesForUser !== undefined &&
    request.runningSandboxesForUser >= entitlement.limits.maxConcurrentSandboxesPerMember
  ) {
    return { allow: false, reason: 'member_concurrency_limit', suspendRunning }
  }
  return { allow: true, reason: null, suspendRunning }
}
