// Plan catalog. One self-serve plan (Team, per seat, monthly or annual) plus Enterprise (contact
// sales, no Stripe price). Stripe price ids are Worker vars; every number and label below is a
// default that BILLING_PLANS (JSON) can override, so pricing changes need no code change.
//
// Usage is metered in "standard seconds": wall-clock seconds x the machine size weight. There is
// one size, Standard (ORCA_CLOUD_SANDBOX_SPEC, 8 vCPU / 16 GB), so one included hour is one hour
// awake. 'large' stays on the wire for older clients and rows not yet migrated; the control plane
// runs it as Standard, so it also counts 1x.
// Included hours are a MONTHLY per-seat allowance pooled across the org, for annual plans too.
import { z } from 'zod'
import {
  ORCA_CLOUD_IDLE_SLEEP_MINUTES,
  ORCA_CLOUD_OVERAGE_CENTS_PER_HOUR
} from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import type { Env } from './env'

export const PLAN_IDS = ['team'] as const
export type PlanId = (typeof PLAN_IDS)[number]
export const BILLING_INTERVALS = ['month', 'year'] as const
export type BillingInterval = (typeof BILLING_INTERVALS)[number]

export const MACHINE_SIZES = ['standard', 'large'] as const
export type MachineSize = (typeof MACHINE_SIZES)[number]
export const MACHINE_SIZE_WEIGHT: Record<MachineSize, number> = { standard: 1, large: 1 }

const TeamSchema = z
  .object({
    label: z.string().min(1).max(40),
    // Display only; Stripe's prices are what is charged.
    monthlyPriceLabel: z.string().max(40),
    annualPriceLabel: z.string().max(40),
    // Display only, for totals and the annual saving on the plans page; must match Stripe's prices.
    monthlyPriceCentsPerSeat: z.number().int().nonnegative(),
    annualPriceCentsPerSeat: z.number().int().nonnegative(),
    includedHoursPerSeat: z.number().nonnegative(),
    concurrentSandboxesPerSeat: z.number().int().nonnegative(),
    machineSizes: z.array(z.enum(MACHINE_SIZES)).min(1),
    idleSleepMinutes: z.number().int().positive(),
    // Overage: opt-in per account. The Stripe overage price must match overageCentsPerHour.
    overageCentsPerHour: z.number().int().positive(),
    defaultSpendCapCents: z.number().int().nonnegative(),
    maxSpendCapCents: z.number().int().positive(),
    // Included-hours usage levels (percent) the desktop warns at.
    warnAtPercent: z.array(z.number().int().min(1).max(100)).max(4),
    // After a failed payment: new starts stop at once; running sandboxes are suspended after this.
    paymentGraceHours: z.number().nonnegative(),
    // Seats only come down to the member count this close to renewal (never mid-period).
    seatTrueDownHours: z.number().positive()
  })
  .strict()

const EnterpriseSchema = z
  .object({
    label: z.string().min(1).max(40),
    priceLabel: z.string().max(40),
    contactUrl: z.string().url().startsWith('https://')
  })
  .strict()

export type TeamPlan = z.infer<typeof TeamSchema>
export type EnterpriseOffer = z.infer<typeof EnterpriseSchema>
export type PlanCatalog = { team: TeamPlan; enterprise: EnterpriseOffer }

export const DEFAULT_PLANS: PlanCatalog = {
  team: {
    label: 'Team',
    monthlyPriceLabel: '$50 per seat per month',
    annualPriceLabel: '$480 per seat, billed yearly',
    monthlyPriceCentsPerSeat: 5000,
    annualPriceCentsPerSeat: 48000,
    includedHoursPerSeat: 60,
    concurrentSandboxesPerSeat: 3,
    machineSizes: ['standard', 'large'],
    // Same constant the control plane enforces and serves (GET /v1/config); never a literal here.
    idleSleepMinutes: ORCA_CLOUD_IDLE_SLEEP_MINUTES,
    // Shared with the control plane's workspace cost; entitlements, the spend-cap math, the desktop and
    // the e2e read it from here. STRIPE_PRICE_OVERAGE must be the metered per-minute price for this rate
    // (unit_amount_decimal = overageUnitAmountDecimal(rate), transform_quantity divide_by 60, round up).
    overageCentsPerHour: ORCA_CLOUD_OVERAGE_CENTS_PER_HOUR,
    defaultSpendCapCents: 2500,
    maxSpendCapCents: 500_000,
    // Owners and admins are alerted at 75%, 90% and 100% of the team's sandbox hours.
    warnAtPercent: [75, 90, 100],
    paymentGraceHours: 96,
    seatTrueDownHours: 6
  },
  enterprise: {
    label: 'Enterprise',
    priceLabel: 'Custom',
    contactUrl: 'https://onorca.dev/contact-sales'
  }
}

const OverridesSchema = z
  .object({ team: TeamSchema.partial().optional(), enterprise: EnterpriseSchema.partial().optional() })
  .strict()

export class PlanConfigError extends Error {
  constructor() {
    super('billing_plans_invalid')
    this.name = 'PlanConfigError'
  }
}

const catalogs = new Map<string, PlanCatalog>()

/** The effective catalog. Throws PlanConfigError (-> 503) on malformed BILLING_PLANS. */
export function planCatalog(env: Pick<Env, 'BILLING_PLANS'>): PlanCatalog {
  const raw = env.BILLING_PLANS?.trim() ?? ''
  const cached = catalogs.get(raw)
  if (cached) {
    return cached
  }
  let catalog: PlanCatalog
  try {
    const overrides = raw ? OverridesSchema.parse(JSON.parse(raw)) : {}
    catalog = {
      team: TeamSchema.parse({ ...DEFAULT_PLANS.team, ...overrides.team }),
      enterprise: EnterpriseSchema.parse({ ...DEFAULT_PLANS.enterprise, ...overrides.enterprise })
    }
  } catch {
    throw new PlanConfigError()
  }
  catalogs.set(raw, catalog)
  return catalog
}

/** What the desktop shows before Checkout. */
export function publicOffers(catalog: PlanCatalog) {
  const team = catalog.team
  return {
    team: {
      label: team.label,
      monthlyPriceLabel: team.monthlyPriceLabel,
      annualPriceLabel: team.annualPriceLabel,
      monthlyPriceCentsPerSeat: team.monthlyPriceCentsPerSeat,
      annualPriceCentsPerSeat: team.annualPriceCentsPerSeat,
      largeMachineWeight: MACHINE_SIZE_WEIGHT.large,
      includedHoursPerSeat: team.includedHoursPerSeat,
      concurrentSandboxesPerSeat: team.concurrentSandboxesPerSeat,
      idleSleepMinutes: team.idleSleepMinutes,
      overageCentsPerHour: team.overageCentsPerHour,
      defaultSpendCapCents: team.defaultSpendCapCents,
      maxSpendCapCents: team.maxSpendCapCents
    },
    enterprise: catalog.enterprise
  }
}

export function priceForPlan(env: Env, interval: BillingInterval): string {
  return interval === 'year' ? env.STRIPE_PRICE_TEAM_ANNUAL : env.STRIPE_PRICE_TEAM_MONTHLY
}

/** The plan and interval a subscription's seat price maps to, or null for a price we did not configure. */
export function planForPrice(env: Env, priceId: string): { plan: PlanId; interval: BillingInterval } | null {
  if (priceId === env.STRIPE_PRICE_TEAM_MONTHLY) {
    return { plan: 'team', interval: 'month' }
  }
  if (priceId === env.STRIPE_PRICE_TEAM_ANNUAL) {
    return { plan: 'team', interval: 'year' }
  }
  return null
}

export function includedSeconds(team: TeamPlan, seats: number): number {
  return Math.round(team.includedHoursPerSeat * 3600) * Math.max(1, seats)
}

// Overage is billed by the minute: the meter counts seconds, and the Stripe price divides the
// period's total by 60 (rounding up) and charges overageCentsPerHour / 60 per minute. Metering in
// seconds keeps every segment exact; only the invoice rounds, once per period, to a whole minute.
export const OVERAGE_SECONDS_PER_BILLED_UNIT = 60
/** Stripe allows at most 12 decimal places in unit_amount_decimal. */
const STRIPE_DECIMAL_PLACES = 12

/** The per-minute Stripe price (cents, as Stripe's unit_amount_decimal string) for an hourly rate. */
export function overageUnitAmountDecimal(centsPerHour: number): string {
  return (centsPerHour / (3600 / OVERAGE_SECONDS_PER_BILLED_UNIT)).toFixed(STRIPE_DECIMAL_PLACES)
}

/** What Stripe invoices for `seconds` of overage: whole minutes (rounded up) at the per-minute rate. */
export function overageCents(team: Pick<TeamPlan, 'overageCentsPerHour'>, seconds: number): number {
  const minutes = Math.ceil(Math.max(0, seconds) / OVERAGE_SECONDS_PER_BILLED_UNIT)
  return Math.round(minutes * Number(overageUnitAmountDecimal(team.overageCentsPerHour)))
}

/**
 * The spend cap expressed as overage seconds (what the meter counts): the whole minutes the cap
 * pays for, so the invoice never goes over the cap after Stripe rounds up to the minute.
 */
export function capSeconds(team: Pick<TeamPlan, 'overageCentsPerHour'>, spendCapCents: number): number {
  const minutes = Math.floor((spendCapCents * (3600 / OVERAGE_SECONDS_PER_BILLED_UNIT)) / team.overageCentsPerHour)
  return minutes * OVERAGE_SECONDS_PER_BILLED_UNIT
}

function addUtcMonths(ms: number, months: number): number {
  const date = new Date(ms)
  const day = date.getUTCDate()
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1, date.getUTCHours(),
    date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()))
  // Clamp to the target month's last day (Jan 31 + 1 month = Feb 28/29), like Stripe's anchors.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return target.getTime()
}

/**
 * The monthly allowance window containing `at`: the billing period itself for monthly plans,
 * one calendar-month slice of the year (anchored on the period start) for annual plans.
 */
export function allowanceWindow(period: { start: number; end: number }, at: number): { start: number; end: number } {
  let start = period.start
  for (let month = 1; month <= 12; month++) {
    const next = Math.min(addUtcMonths(period.start, month), period.end)
    if (at < next || next >= period.end) {
      return { start, end: next }
    }
    start = next
  }
  return { start, end: period.end }
}
