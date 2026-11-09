// Plan catalog. One self-serve plan (Team, per seat, monthly or annual) plus Enterprise (contact
// sales, no Stripe price). Stripe price ids are Worker vars; every number and label below is a
// default that BILLING_PLANS (JSON) can override, so pricing changes need no code change.
//
// Usage is metered in "standard seconds": wall-clock seconds x the machine size weight, so one
// included hour is one hour on the Standard 4 vCPU / 8 GB box and a Large box burns 2x.
// Included hours are a MONTHLY per-seat allowance pooled across the org, for annual plans too.
import { z } from 'zod'
import type { Env } from './env'

export const PLAN_IDS = ['team'] as const
export type PlanId = (typeof PLAN_IDS)[number]
export const BILLING_INTERVALS = ['month', 'year'] as const
export type BillingInterval = (typeof BILLING_INTERVALS)[number]

export const MACHINE_SIZES = ['standard', 'large'] as const
export type MachineSize = (typeof MACHINE_SIZES)[number]
export const MACHINE_SIZE_WEIGHT: Record<MachineSize, number> = { standard: 1, large: 2 }

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
    monthlyPriceLabel: '$50/seat/mo',
    annualPriceLabel: '$480/seat/yr',
    monthlyPriceCentsPerSeat: 5000,
    annualPriceCentsPerSeat: 48000,
    includedHoursPerSeat: 60,
    concurrentSandboxesPerSeat: 3,
    machineSizes: ['standard', 'large'],
    idleSleepMinutes: 15,
    overageCentsPerHour: 75,
    defaultSpendCapCents: 2500,
    maxSpendCapCents: 500_000,
    warnAtPercent: [80, 100],
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
      defaultSpendCapCents: team.defaultSpendCapCents
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

/** The spend cap expressed as overage seconds (what the meter counts). */
export function capSeconds(team: TeamPlan, spendCapCents: number): number {
  return Math.floor((spendCapCents / team.overageCentsPerHour) * 3600)
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
