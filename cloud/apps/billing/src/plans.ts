// Plan catalog. Prices live in Stripe; this file owns what each plan entitles.
// Usage is metered in "standard seconds": wall-clock seconds x the machine size weight, so one
// included hour is one hour on the standard 4 vCPU / 8 GB box.
import type { Env } from './env'

export const PLAN_IDS = ['pro', 'max', 'team'] as const
export type PlanId = (typeof PLAN_IDS)[number]

export const MACHINE_SIZES = ['standard', 'large', 'xlarge'] as const
export type MachineSize = (typeof MACHINE_SIZES)[number]

export const MACHINE_SIZE_WEIGHT: Record<MachineSize, number> = { standard: 1, large: 2, xlarge: 4 }

export type PlanEntitlement = {
  plan: PlanId
  label: string
  // Included standard hours per billing period; Team multiplies by seats (pooled).
  includedHoursPerSeat: number
  maxConcurrentSandboxes: number
  machineSizes: readonly MachineSize[]
  // Overage hours allowed per period before new starts are refused (spend cap).
  overageCapHours: number
}

export const PLANS: Record<PlanId, PlanEntitlement> = {
  pro: {
    plan: 'pro',
    label: 'Pro',
    includedHoursPerSeat: 50,
    maxConcurrentSandboxes: 2,
    machineSizes: ['standard'],
    overageCapHours: 100
  },
  max: {
    plan: 'max',
    label: 'Max',
    includedHoursPerSeat: 300,
    maxConcurrentSandboxes: 5,
    machineSizes: ['standard', 'large', 'xlarge'],
    overageCapHours: 500
  },
  team: {
    plan: 'team',
    label: 'Team',
    includedHoursPerSeat: 150,
    maxConcurrentSandboxes: 3,
    machineSizes: ['standard', 'large'],
    overageCapHours: 200
  }
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

export function includedSeconds(plan: PlanId, seats: number): number {
  const perSeat = PLANS[plan].includedHoursPerSeat * 3600
  return plan === 'team' ? perSeat * Math.max(1, seats) : perSeat
}

export function overageCapSeconds(plan: PlanId, seats: number): number {
  const cap = PLANS[plan].overageCapHours * 3600
  return plan === 'team' ? cap * Math.max(1, seats) : cap
}
