// One-time TEST MODE catalog setup: products, flat plan prices, the sandbox-seconds meter and the
// metered overage price. Refuses any key that is not sk_test_/rk_test_. Prints the ids to put in
// the Worker vars; creates nothing else.
//
//   STRIPE_SECRET_KEY=sk_test_... pnpm tsx scripts/stripe-test-setup.ts
//
// Re-running is safe within 24h (idempotency keys); after that it would create duplicates, so
// check the dashboard first.
import { encodeForm } from '../src/stripe'

const key = process.env.STRIPE_SECRET_KEY ?? ''
if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
  console.error('Refusing: STRIPE_SECRET_KEY must be a test-mode key (sk_test_ or rk_test_).')
  process.exit(1)
}

async function post<T>(path: string, params: Record<string, unknown>, idempotencyKey: string): Promise<T> {
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/x-www-form-urlencoded',
      'stripe-version': '2025-09-30.clover',
      'idempotency-key': `orca-billing-setup:${idempotencyKey}`
    },
    body: encodeForm(params as never)
  })
  const json = (await response.json()) as T & { livemode?: boolean; error?: { message: string } }
  if (!response.ok) {
    throw new Error(`${path}: ${json.error?.message}`)
  }
  if (json.livemode) {
    throw new Error('Stripe reported a live-mode object; stopping.')
  }
  return json
}

// Monthly price in cents per plan (Team is per seat) and the overage price per standard hour.
// Draft numbers; override with STRIPE_SETUP_PRICES='{"pro":2000,"max":10000,"team":5000,"overagePerHour":45}'.
const prices = { pro: 2500, max: 10000, team: 6000, overagePerHour: 45, ...JSON.parse(process.env.STRIPE_SETUP_PRICES ?? '{}') }
const plans = [
  { id: 'pro', name: 'Orca Pro', cents: prices.pro },
  { id: 'max', name: 'Orca Max', cents: prices.max },
  { id: 'team', name: 'Orca Team (per seat)', cents: prices.team }
] as const
const suffix = `${prices.pro}-${prices.max}-${prices.team}-${prices.overagePerHour}`

const out: Record<string, string> = {}
for (const plan of plans) {
  const product = await post<{ id: string }>('/v1/products', { name: plan.name, metadata: { orca_plan: plan.id } }, `product:${plan.id}`)
  const price = await post<{ id: string }>(
    '/v1/prices',
    { product: product.id, currency: 'usd', unit_amount: plan.cents, recurring: { interval: 'month' }, lookup_key: `orca_${plan.id}_monthly`, transfer_lookup_key: true },
    `price:${plan.id}:${suffix}`
  )
  out[`STRIPE_PRICE_${plan.id.toUpperCase()}`] = price.id
}

const meter = await post<{ id: string; event_name: string }>(
  '/v1/billing/meters',
  {
    display_name: 'Orca sandbox overage (standard seconds)',
    event_name: 'orca_sandbox_seconds',
    default_aggregation: { formula: 'sum' },
    customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
    value_settings: { event_payload_key: 'value' }
  },
  'meter'
)
const overageProduct = await post<{ id: string }>('/v1/products', { name: 'Orca sandbox overage', unit_label: 'hour' }, 'product:overage')
// Per standard hour; the meter counts seconds and Stripe divides by 3600 (rounding up) on the invoice.
const overage = await post<{ id: string }>(
  '/v1/prices',
  {
    product: overageProduct.id,
    currency: 'usd',
    unit_amount: prices.overagePerHour,
    recurring: { interval: 'month', usage_type: 'metered', meter: meter.id },
    transform_quantity: { divide_by: 3600, round: 'up' },
    lookup_key: 'orca_sandbox_overage_hourly',
    transfer_lookup_key: true
  },
  `price:overage:${suffix}`
)
out.STRIPE_PRICE_OVERAGE = overage.id
out.STRIPE_METER_EVENT_NAME = meter.event_name

console.log(JSON.stringify(out, null, 2))
