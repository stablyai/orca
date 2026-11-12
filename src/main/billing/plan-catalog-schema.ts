// Lenient parse of billing's GET /v1/plans. A newer service must never break an older desktop:
// unknown fields are ignored, an unknown plan kind is kept as "other", and a malformed plan, price
// or feature is dropped on its own rather than failing the whole catalog.
import { z } from 'zod'
import { ORCA_BILLING_INTERVALS, ORCA_BILLING_MAX_SEATS } from '../../shared/orca-billing'
import type {
  OrcaPlanCatalog,
  OrcaPlanCatalogPlan,
  OrcaPlanFeature,
  OrcaPlanPrice
} from '../../shared/orca-billing-plans'

const MAX_PLANS = 20
const MAX_FEATURES = 20

const Feature = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/),
  params: z
    .record(z.string(), z.union([z.string().max(100), z.number()]))
    .catch({})
    .default({}),
  text: z.string().min(1).max(200)
})

const Price = z.object({
  interval: z.enum(ORCA_BILLING_INTERVALS),
  unitAmountCents: z.number().int().nonnegative(),
  currency: z.string().regex(/^[a-z]{3}$/)
})

const Base = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  kind: z.string().min(1).max(40),
  name: z.string().min(1).max(40),
  version: z.number().int().nonnegative().catch(0),
  features: z.array(z.unknown()).max(100).catch([]),
  entitlements: z.record(z.string(), z.unknown()).catch({}).optional(),
  // "Contact us" for this plan. https only: the desktop opens links through shell:openUrl, which
  // refuses other schemes (a mailto: from billing falls back to the Enterprise contact).
  supportUrl: z.string().url().startsWith('https://').max(500).nullable().catch(null).optional()
})

const SelfServe = z.object({
  prices: z.array(z.unknown()).max(10).catch([]),
  overage: z
    .object({
      centsPerHour: z.number().int().positive(),
      defaultSpendCapCents: z.number().int().nonnegative(),
      maxSpendCapCents: z.number().int().positive()
    })
    .nullable()
    .catch(null)
    .optional(),
  seats: z
    .object({ min: z.number().int().min(1), max: z.number().int().min(1) })
    .refine((seats) => seats.min <= seats.max)
    .catch({ min: 1, max: ORCA_BILLING_MAX_SEATS })
    .optional(),
  checkout: z.object({ available: z.boolean() }).catch({ available: false }).optional()
})

const ContactSales = z.object({
  contactUrl: z.string().url().startsWith('https://').max(500).nullable().catch(null).optional(),
  priceLabel: z.string().max(40).nullable().catch(null).optional()
})

function features(raw: unknown[]): OrcaPlanFeature[] {
  return raw.slice(0, MAX_FEATURES).flatMap((entry) => {
    const parsed = Feature.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

function prices(raw: unknown[]): OrcaPlanPrice[] {
  const seen = new Set<string>()
  return raw.flatMap((entry) => {
    const parsed = Price.safeParse(entry)
    if (!parsed.success || seen.has(parsed.data.interval)) {
      return []
    }
    seen.add(parsed.data.interval)
    return [parsed.data]
  })
}

/** Per-seat monthly hours from the plan's entitlements, when it grants them per seat. */
function perSeatHours(entitlements: Record<string, unknown> | undefined): number | null {
  const entry = entitlements?.sandbox_hours_monthly
  const parsed = z
    .object({ value: z.number().nonnegative(), perSeat: z.literal(true) })
    .safeParse(entry)
  return parsed.success ? parsed.data.value : null
}

function plan(raw: unknown): OrcaPlanCatalogPlan | null {
  const base = Base.safeParse(raw)
  if (!base.success) {
    return null
  }
  const common = {
    id: base.data.id,
    name: base.data.name,
    version: base.data.version,
    features: features(base.data.features),
    supportUrl: base.data.supportUrl ?? null
  }
  if (base.data.kind === 'self_serve') {
    const extra = SelfServe.safeParse(raw)
    if (!extra.success) {
      return null
    }
    const sold = prices(extra.data.prices)
    return {
      ...common,
      kind: 'self_serve',
      prices: sold,
      overage: extra.data.overage ?? null,
      seats: extra.data.seats ?? { min: 1, max: ORCA_BILLING_MAX_SEATS },
      includedHoursPerSeat: perSeatHours(base.data.entitlements),
      checkoutAvailable: (extra.data.checkout?.available ?? false) && sold.length > 0
    }
  }
  if (base.data.kind === 'contact_sales') {
    const extra = ContactSales.safeParse(raw)
    return {
      ...common,
      kind: 'contact_sales',
      contactUrl: extra.success ? (extra.data.contactUrl ?? null) : null,
      priceLabel: extra.success ? (extra.data.priceLabel ?? null) : null
    }
  }
  return { ...common, kind: base.data.kind }
}

const Catalog = z.object({
  schemaVersion: z.literal(1),
  catalogVersion: z.string().max(100).catch(''),
  plans: z.array(z.unknown()).max(100)
})

/** The catalog, or null when the body isn't a v1 catalog at all. */
export function parsePlanCatalog(body: unknown): OrcaPlanCatalog | null {
  const parsed = Catalog.safeParse(body)
  if (!parsed.success) {
    return null
  }
  const plans = parsed.data.plans
    .slice(0, MAX_PLANS)
    .map(plan)
    .filter((entry): entry is OrcaPlanCatalogPlan => entry !== null)
  return { catalogVersion: parsed.data.catalogVersion, plans }
}
