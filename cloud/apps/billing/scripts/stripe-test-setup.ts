// One-time TEST MODE catalog setup: the Team product with monthly + annual seat prices, the
// sandbox-seconds meter with its metered overage price, and a Customer Portal configuration
// (monthly <-> annual switch, cancel; seats follow membership). Refuses any key that is not
// sk_test_/rk_test_ and stops if Stripe ever reports a live-mode object. Prints the Worker vars.
//
//   STRIPE_SECRET_KEY=sk_test_... BILLING_RETURN_URL=https://... tsx scripts/stripe-test-setup.ts
//
// Prices (cents) default to the agreed Team pricing; override with
//   STRIPE_SETUP_PRICES='{"teamMonthly":5000,"teamAnnual":48000,"overagePerHour":75}'
// Idempotency keys include the prices, so a re-run within 24h returns the same objects.
import { encodeForm } from '../src/stripe'

const key = process.env.STRIPE_SECRET_KEY ?? ''
if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
  console.error('Refusing: STRIPE_SECRET_KEY must be a test-mode key (sk_test_ or rk_test_).')
  process.exit(1)
}
const returnUrl = process.env.BILLING_RETURN_URL ?? 'https://onorca.dev/billing/return'

type StripeObject = { id: string; livemode?: boolean; error?: { message: string } }

async function post<T extends StripeObject>(path: string, params: Record<string, unknown>, idempotencyKey: string): Promise<T> {
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
  const json = (await response.json()) as T
  if (!response.ok) {
    throw new Error(`${path}: ${json.error?.message}`)
  }
  if (json.livemode) {
    throw new Error('Stripe reported a live-mode object; stopping.')
  }
  return json
}

const prices = { teamMonthly: 5000, teamAnnual: 48000, overagePerHour: 75, ...JSON.parse(process.env.STRIPE_SETUP_PRICES ?? '{}') }
const suffix = `${prices.teamMonthly}-${prices.teamAnnual}-${prices.overagePerHour}`

const team = await post('/v1/products', { name: 'Orca Team', unit_label: 'seat', metadata: { orca_plan: 'team' } }, 'product:team')
const monthly = await post(
  '/v1/prices',
  {
    product: team.id,
    currency: 'usd',
    unit_amount: prices.teamMonthly,
    recurring: { interval: 'month' },
    lookup_key: 'orca_team_seat_monthly',
    transfer_lookup_key: true
  },
  `price:team:month:${suffix}`
)
const annual = await post(
  '/v1/prices',
  {
    product: team.id,
    currency: 'usd',
    unit_amount: prices.teamAnnual,
    recurring: { interval: 'year' },
    lookup_key: 'orca_team_seat_annual',
    transfer_lookup_key: true
  },
  `price:team:year:${suffix}`
)

const meter = await post<StripeObject & { event_name: string }>(
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
const overageProduct = await post('/v1/products', { name: 'Orca sandbox overage', unit_label: 'std hour' }, 'product:overage')
// Per sandbox hour (one size, 1x; see MACHINE_SIZE_WEIGHT); the meter counts seconds and the
// invoice divides by 3600, rounding up.
const overage = await post(
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

const portal = await post(
  '/v1/billing_portal/configurations',
  {
    business_profile: { headline: 'Orca Team billing' },
    default_return_url: returnUrl,
    features: {
      customer_update: { enabled: true, allowed_updates: ['email', 'address', 'tax_id', 'name'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: true, options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'] } },
      subscription_update: {
        enabled: true,
        // Seats follow org membership (seats.ts); the portal only switches monthly <-> annual.
        default_allowed_updates: ['price'],
        proration_behavior: 'create_prorations',
        products: [{ product: team.id, prices: [monthly.id, annual.id] }]
      }
    }
  },
  `portal:${team.id}:${monthly.id}:${annual.id}`
)

console.log(
  JSON.stringify(
    {
      STRIPE_PRICE_TEAM_MONTHLY: monthly.id,
      STRIPE_PRICE_TEAM_ANNUAL: annual.id,
      STRIPE_PRICE_OVERAGE: overage.id,
      STRIPE_METER_EVENT_NAME: meter.event_name,
      STRIPE_PORTAL_CONFIGURATION: portal.id,
      products: { team: team.id, overage: overageProduct.id },
      meter: meter.id
    },
    null,
    2
  )
)
