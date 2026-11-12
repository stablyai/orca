// The entitlement registry: every key a plan version or grant may carry, its value type, and how
// values from several grants combine. Keys live in code (not the DB) because enforcement must
// understand each one; the catalog and grants only choose values. Unknown keys are rejected.
import { z } from 'zod'
import { MACHINE_SIZES, type MachineSize } from './plans'

export const ENTITLEMENT_KEYS = [
  // Sandbox hours that reset every monthly allowance window (paid plans; per seat on Team).
  'sandbox_hours_monthly',
  // Sandbox hours that never reset (the one-time trial), spent only while there is no plan.
  'sandbox_hours_lifetime',
  'max_concurrent_sandboxes',
  'max_concurrent_sandboxes_per_member',
  'machine_sizes',
  'overage_allowed'
] as const
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number]

type Aggregation = 'sum' | 'max' | 'union' | 'or'

const NonNegative = z.number().finite().nonnegative().max(1_000_000)
const NonNegativeInt = z.number().int().nonnegative().max(1_000_000)

export const ENTITLEMENT_REGISTRY: Record<EntitlementKey, { schema: z.ZodType; aggregate: Aggregation; perSeatAllowed: boolean }> = {
  sandbox_hours_monthly: { schema: NonNegative, aggregate: 'sum', perSeatAllowed: true },
  sandbox_hours_lifetime: { schema: NonNegative, aggregate: 'sum', perSeatAllowed: false },
  max_concurrent_sandboxes: { schema: NonNegativeInt, aggregate: 'sum', perSeatAllowed: true },
  max_concurrent_sandboxes_per_member: { schema: NonNegativeInt, aggregate: 'max', perSeatAllowed: false },
  machine_sizes: { schema: z.array(z.enum(MACHINE_SIZES)).max(MACHINE_SIZES.length), aggregate: 'union', perSeatAllowed: false },
  overage_allowed: { schema: z.boolean(), aggregate: 'or', perSeatAllowed: false }
}

export function isEntitlementKey(value: string): value is EntitlementKey {
  return (ENTITLEMENT_KEYS as readonly string[]).includes(value)
}

export const EntitlementValueSchema = z.object({ value: z.unknown(), perSeat: z.boolean().optional() }).strict()

/** Validates one key's value; throws with the key named. */
export function parseEntitlementValue(key: string, entry: { value: unknown; perSeat?: boolean }): { value: unknown; perSeat: boolean } {
  if (!isEntitlementKey(key)) {
    throw new Error(`unknown entitlement key: ${key}`)
  }
  const definition = ENTITLEMENT_REGISTRY[key]
  const parsed = definition.schema.safeParse(entry.value)
  if (!parsed.success) {
    throw new Error(`invalid value for ${key}`)
  }
  if (entry.perSeat && !definition.perSeatAllowed) {
    throw new Error(`${key} cannot be per seat`)
  }
  return { value: parsed.data, perSeat: entry.perSeat === true }
}

/** One grant's contribution, as the resolver sees it. */
export type GrantValue = { key: EntitlementKey; value: unknown; perSeat: boolean; seats: number | null }

export type EffectiveValues = {
  sandboxSecondsMonthly: number
  sandboxSecondsLifetime: number
  maxConcurrentSandboxes: number
  maxConcurrentSandboxesPerMember: number
  machineSizes: MachineSize[]
  overageAllowed: boolean
}

/** Combines grant values by each key's rule. Per-seat values multiply by max(1, seats). */
export function aggregateGrants(grants: readonly GrantValue[]): EffectiveValues {
  const sums: Record<string, number> = {}
  const maxes: Record<string, number> = {}
  const sizes = new Set<MachineSize>()
  let overage = false
  for (const grant of grants) {
    const multiplier = grant.perSeat ? Math.max(1, grant.seats ?? 1) : 1
    const definition = ENTITLEMENT_REGISTRY[grant.key]
    switch (definition.aggregate) {
      case 'sum':
        sums[grant.key] = (sums[grant.key] ?? 0) + Number(grant.value) * multiplier
        break
      case 'max':
        maxes[grant.key] = Math.max(maxes[grant.key] ?? 0, Number(grant.value) * multiplier)
        break
      case 'union':
        for (const size of grant.value as MachineSize[]) {
          sizes.add(size)
        }
        break
      case 'or':
        overage = overage || grant.value === true
        break
    }
  }
  return {
    // Seconds are what usage is metered in; round once here.
    sandboxSecondsMonthly: Math.round((sums.sandbox_hours_monthly ?? 0) * 3600),
    sandboxSecondsLifetime: Math.round((sums.sandbox_hours_lifetime ?? 0) * 3600),
    maxConcurrentSandboxes: sums.max_concurrent_sandboxes ?? 0,
    maxConcurrentSandboxesPerMember: maxes.max_concurrent_sandboxes_per_member ?? 0,
    // Registry order, so the list is stable whatever order grants came in.
    machineSizes: MACHINE_SIZES.filter((size) => sizes.has(size)),
    overageAllowed: overage
  }
}
