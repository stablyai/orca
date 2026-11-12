// Stripe is the only price authority. This module
// - syncs plan_prices from the Stripe Prices holding each plan's lookup keys (cron, and on
//   price.* / product.* webhooks): what Checkout sells and GET /v1/plans shows;
// - records every seat price a subscription is seen on (price history), so a subscriber on an
//   older price keeps mapping to its plan after the lookup key moves to a new price;
// - maps a subscription item's price to a plan + interval: the configured env ids, any price we
//   have seen for the plan, a price holding the plan's lookup key, or one on the plan's product.
import { invalidateCatalog, loadCatalog, type Catalog, type PlanPriceRow } from './catalog'
import type { Env } from './env'
import { BILLING_INTERVALS, PLAN_IDS, planForPrice, type BillingInterval, type PlanId } from './plans'
import { StripeError, type StripeClient, type StripePrice } from './stripe'

export type PriceMatch = { plan: PlanId; interval: BillingInterval }

function productId(price: StripePrice): string | null {
  const product = price.product
  if (typeof product === 'string') {
    return product
  }
  return product && typeof product === 'object' && typeof product.id === 'string' ? product.id : null
}

function asInterval(value: unknown): BillingInterval | null {
  return (BILLING_INTERVALS as readonly unknown[]).includes(value) ? (value as BillingInterval) : null
}

function asPlan(value: unknown): PlanId | null {
  return (PLAN_IDS as readonly unknown[]).includes(value) ? (value as PlanId) : null
}

/** The catalog when one was applied; null otherwise (the env price ids still work). */
export async function catalogIfApplied(db: D1Database, now: number): Promise<Catalog | null> {
  try {
    return await loadCatalog(db, now)
  } catch {
    return null
  }
}

/** Is this item the metered overage price (the current env one, or any overage price we synced)? */
export function isOveragePrice(env: Pick<Env, 'STRIPE_PRICE_OVERAGE'>, catalog: Catalog | null, price: StripePrice): boolean {
  if (price.id === env.STRIPE_PRICE_OVERAGE) {
    return true
  }
  return catalog?.prices.some((row) => row.stripe_price_id === price.id && row.role === 'overage') ?? false
}

/** Which plan and interval a seat price sells, or null when it isn't one of ours. */
export function seatPriceMatch(env: Env, catalog: Catalog | null, price: StripePrice): PriceMatch | null {
  const configured = planForPrice(env, price.id)
  if (configured) {
    return configured
  }
  if (!catalog || isOveragePrice(env, catalog, price) || price.recurring?.usage_type === 'metered') {
    return null
  }
  const known = catalog.prices.find((row) => row.stripe_price_id === price.id && row.role === 'seat')
  if (known) {
    const plan = asPlan(known.plan_id)
    const interval = asInterval(known.interval)
    return plan && interval ? { plan, interval } : null
  }
  const interval = asInterval(price.recurring?.interval)
  if (!interval) {
    return null
  }
  for (const plan of catalog.plans.values()) {
    const id = asPlan(plan.id)
    if (!id || plan.kind !== 'self_serve') {
      continue
    }
    if (price.lookup_key && plan.config.stripe?.seatLookupKeys[interval] === price.lookup_key) {
      return { plan: id, interval }
    }
  }
  // A new price on a plan's product (the lookup key moved before we ever saw this price).
  const product = productId(price)
  if (product) {
    const owner = catalog.prices.find((row) => row.role === 'seat' && row.stripe_product_id === product)
    const plan = owner ? asPlan(owner.plan_id) : null
    if (plan) {
      return { plan, interval }
    }
  }
  return null
}

const UPSERT_PRICE = `INSERT INTO plan_prices (stripe_price_id, plan_id, plan_version, role, interval, lookup_key, unit_amount,
    unit_amount_decimal, currency, active, is_checkout_price, stripe_product_id, synced_at)
  VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
  ON CONFLICT (stripe_price_id) DO UPDATE SET
    lookup_key = excluded.lookup_key, unit_amount = excluded.unit_amount, unit_amount_decimal = excluded.unit_amount_decimal,
    currency = excluded.currency, active = excluded.active,
    is_checkout_price = CASE WHEN ?13 = 1 THEN excluded.is_checkout_price ELSE plan_prices.is_checkout_price END,
    stripe_product_id = COALESCE(excluded.stripe_product_id, plan_prices.stripe_product_id), synced_at = excluded.synced_at`

function priceStatement(
  db: D1Database,
  args: { price: StripePrice; planId: string; role: 'seat' | 'overage'; interval: string | null; checkout: boolean; setCheckout: boolean; now: number }
): D1PreparedStatement {
  const { price } = args
  return db
    .prepare(UPSERT_PRICE)
    .bind(
      price.id,
      args.planId,
      args.role,
      args.interval,
      price.lookup_key ?? null,
      typeof price.unit_amount === 'number' ? price.unit_amount : null,
      typeof price.unit_amount_decimal === 'string' ? price.unit_amount_decimal : null,
      price.currency ?? null,
      price.active === false ? 0 : 1,
      args.checkout ? 1 : 0,
      productId(price),
      args.now,
      args.setCheckout ? 1 : 0
    )
}

/** Remembers the seat prices a subscription is on (never changes which price Checkout sells). */
export async function recordSubscriptionPrices(
  db: D1Database,
  catalog: Catalog,
  items: Array<{ price: StripePrice; match: PriceMatch }>,
  now: number
): Promise<void> {
  const fresh = items.filter(({ price }) => {
    const row = catalog.prices.find((entry) => entry.stripe_price_id === price.id)
    return !row || row.unit_amount !== (price.unit_amount ?? null) || row.active !== (price.active === false ? 0 : 1)
  })
  if (fresh.length === 0) {
    return
  }
  await db.batch(
    fresh.map(({ price, match }) =>
      priceStatement(db, { price, planId: match.plan, role: 'seat', interval: match.interval, checkout: false, setCheckout: false, now })
    )
  )
  invalidateCatalog(db)
}

/**
 * Refreshes the prices holding each plan's lookup keys. The holder of a key becomes the checkout
 * price for its plan/role/interval; any other price there stops being one (it stays as history).
 */
export async function syncCatalogPrices(
  env: Env,
  stripe: StripeClient,
  now: number
): Promise<{ synced: number; missing: string[]; error?: string }> {
  const catalog = await catalogIfApplied(env.BILLING_DB, now)
  if (!catalog) {
    return { synced: 0, missing: [], error: 'catalog_unavailable' }
  }
  const wanted: Array<{ key: string; planId: string; role: 'seat' | 'overage'; interval: string | null }> = []
  for (const plan of catalog.plans.values()) {
    const stripeConfig = plan.config.stripe
    if (!stripeConfig) {
      continue
    }
    for (const interval of BILLING_INTERVALS) {
      const key = stripeConfig.seatLookupKeys[interval]
      if (key) {
        wanted.push({ key, planId: plan.id, role: 'seat', interval })
      }
    }
    if (stripeConfig.overageLookupKey) {
      wanted.push({ key: stripeConfig.overageLookupKey, planId: plan.id, role: 'overage', interval: 'month' })
    }
  }
  if (wanted.length === 0) {
    return { synced: 0, missing: [] }
  }
  let prices: StripePrice[]
  try {
    prices = (await stripe.listPricesByLookupKeys([...new Set(wanted.map((entry) => entry.key))])).data
  } catch (error) {
    // A restricted key without Prices read answers 403: keep the prices we have, and say so.
    const message = error instanceof StripeError ? `stripe_${error.status}` : 'stripe_unreachable'
    console.error(JSON.stringify({ error: 'catalog_price_sync', message }))
    return { synced: 0, missing: wanted.map((entry) => entry.key), error: message }
  }
  if (prices.some((price) => price.livemode === true) && env.STRIPE_ALLOW_LIVEMODE !== 'true') {
    return { synced: 0, missing: [], error: 'livemode_price' }
  }
  const db = env.BILLING_DB
  const statements: D1PreparedStatement[] = []
  const missing: string[] = []
  for (const entry of wanted) {
    const price = prices.find((candidate) => candidate.lookup_key === entry.key)
    if (!price) {
      missing.push(entry.key)
      continue
    }
    statements.push(
      priceStatement(db, { price, planId: entry.planId, role: entry.role, interval: entry.interval, checkout: true, setCheckout: true, now }),
      // The key moved: the previous holder stays as history only.
      db
        .prepare(
          `UPDATE plan_prices SET is_checkout_price = 0
           WHERE plan_id = ?1 AND role = ?2 AND interval IS ?3 AND stripe_price_id <> ?4 AND is_checkout_price = 1`
        )
        .bind(entry.planId, entry.role, entry.interval, price.id)
    )
  }
  if (statements.length > 0) {
    await db.batch(statements)
    invalidateCatalog(db)
  }
  if (missing.length > 0) {
    console.error(JSON.stringify({ error: 'catalog_price_missing', lookupKeys: missing }))
  }
  return { synced: wanted.length - missing.length, missing }
}

/** The price Checkout sells for a plan and interval: the current lookup-key holder. */
export function checkoutPrice(catalog: Catalog, planId: string, interval: BillingInterval): PlanPriceRow | null {
  return (
    catalog.prices.find(
      (row) => row.plan_id === planId && row.role === 'seat' && row.interval === interval && row.is_checkout_price === 1 && row.active === 1
    ) ?? null
  )
}
