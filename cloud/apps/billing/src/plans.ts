// Plan catalog. Prices live in Stripe (price ids are Worker vars); what each plan entitles, and
// the price label shown before Checkout, are config too: BILLING_PLANS (JSON) overrides any field
// of the defaults below, so pricing changes need no deploy of code.
// Usage is metered in "standard seconds": wall-clock seconds x the machine size weight, so one
// included hour is one hour on the standard 4 vCPU / 8 GB box.
import { z } from 'zod'
import type { Env } from './env'

export const PLAN_IDS = ['pro', 'max', 'team'] as const
export type PlanId = (typeof PLAN_IDS)[number]

export const MACHINE_SIZES = ['standard', 'large', 'xlarge'] as const
export type MachineSize = (typeof MACHINE_SIZES)[number]

export const MACHINE_SIZE_WEIGHT: Record<MachineSize, number> = { standard: 1, large: 2, xlarge: 4 }

const PlanEntitlementSchema = z
  .object({
    label: z.string().min(1).max(40),
    // Display only (e.g. "$25/mo"); Stripe's price is what is charged.
    priceLabel: z.string().max(40),
    // Included standard hours per billing period; Team multiplies by seats (pooled).
    includedHoursPerSeat: z.number().nonnegative(),
    maxConcurrentSandboxes: z.number().int().nonnegative(),
    machineSizes: z.array(z.enum(MACHINE_SIZES)),
    // Overage hours allowed per period before new starts are refused (spend cap).
    overageCapHours: z.number().nonnegative()
  })
  .strict()

export type PlanEntitlement = z.infer<typeof PlanEntitlementSchema> & { plan: PlanId }
export type PlanCatalog = Record<PlanId, PlanEntitlement>

// Draft numbers from the cloud tracker; override with BILLING_PLANS until pricing is final.
export const DEFAULT_PLANS: PlanCatalog = {
  pro: {
    plan: 'pro',
    label: 'Pro',
    priceLabel: '$25/mo',
    includedHoursPerSeat: 50,
    maxConcurrentSandboxes: 2,
    machineSizes: ['standard'],
    overageCapHours: 100
  },
  max: {
    plan: 'max',
    label: 'Max',
    priceLabel: '$100/mo',
    includedHoursPerSeat: 300,
    maxConcurrentSandboxes: 5,
    machineSizes: ['standard', 'large', 'xlarge'],
    overageCapHours: 500
  },
  team: {
    plan: 'team',
    label: 'Team',
    priceLabel: '$60/seat/mo',
    includedHoursPerSeat: 150,
    maxConcurrentSandboxes: 3,
    machineSizes: ['standard', 'large'],
    overageCapHours: 200
  }
}

const OverridesSchema = z
  .object({
    pro: PlanEntitlementSchema.partial().optional(),
    max: PlanEntitlementSchema.partial().optional(),
    team: PlanEntitlementSchema.partial().optional()
  })
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
  let overrides: z.infer<typeof OverridesSchema> = {}
  if (raw) {
    try {
      overrides = OverridesSchema.parse(JSON.parse(raw))
    } catch {
      throw new PlanConfigError()
    }
  }
  const catalog = {} as PlanCatalog
  for (const plan of PLAN_IDS) {
    catalog[plan] = { ...DEFAULT_PLANS[plan], ...overrides[plan], plan }
  }
  catalogs.set(raw, catalog)
  return catalog
}

/** What the desktop shows before Checkout. */
export function publicPlans(catalog: PlanCatalog) {
  return PLAN_IDS.map((plan) => ({
    plan,
    label: catalog[plan].label,
    priceLabel: catalog[plan].priceLabel,
    includedHours: catalog[plan].includedHoursPerSeat,
    perSeat: plan === 'team'
  }))
}

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value)
}

export function priceForPlan(env: Env, plan: PlanId): string {
  return { pro: env.STRIPE_PRICE_PRO, max: env.STRIPE_PRICE_MAX, team: env.STRIPE_PRICE_TEAM }[plan]
}

/** The plan a subscription's base price maps to, or null for a price we did not configure. */
export function planForPrice(env: Env, priceId: string): PlanId | null {
  for (const plan of PLAN_IDS) {
    if (priceForPlan(env, plan) === priceId) {
      return plan
    }
  }
  return null
}

export function includedSeconds(entry: PlanEntitlement, seats: number): number {
  const perSeat = Math.round(entry.includedHoursPerSeat * 3600)
  return entry.plan === 'team' ? perSeat * Math.max(1, seats) : perSeat
}

export function overageCapSeconds(entry: PlanEntitlement, seats: number): number {
  const cap = Math.round(entry.overageCapHours * 3600)
  return entry.plan === 'team' ? cap * Math.max(1, seats) : cap
}
