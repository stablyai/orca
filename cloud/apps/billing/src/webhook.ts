// Stripe webhook: verify the signature over the raw body, dedupe by event id, then re-read the
// subscription from the API instead of trusting the (possibly stale, possibly out-of-order) payload.
import type { Env } from './env'
import { planForPrice } from './plans'
import { allowsLiveMode, type StripeClient, type StripeSubscription } from './stripe'
import { accountForCustomer, claimEvent, customerFor, finishEvent, upsertSubscription } from './store'
import { splitSecrets, verifyStripeSignature } from './webhook-signature'

const MAX_BODY_BYTES = 512 * 1024

type StripeEvent = {
  id: string
  type: string
  livemode: boolean
  data: { object: Record<string, unknown> }
}

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed'
])
const INVOICE_EVENTS = new Set(['invoice.paid', 'invoice.payment_failed'])

function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value) {
    return value
  }
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id
  }
  return null
}

/** The subscription an event concerns, across the payload shapes of old and new API versions. */
export function subscriptionIdFor(event: StripeEvent): string | null {
  const object = event.data.object
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    return idOf(object.id)
  }
  if (event.type === 'checkout.session.completed') {
    return object.mode === 'subscription' ? idOf(object.subscription) : null
  }
  if (INVOICE_EVENTS.has(event.type)) {
    const parent = object.parent as { subscription_details?: { subscription?: unknown } } | undefined
    return idOf(object.subscription) ?? idOf(parent?.subscription_details?.subscription)
  }
  return null
}

class IgnoredSubscription extends Error {}

export async function syncSubscription(env: Env, stripe: StripeClient, subscriptionId: string, now: number) {
  const subscription: StripeSubscription = await stripe.retrieveSubscription(subscriptionId)
  if (subscription.livemode && !allowsLiveMode(env)) {
    throw new IgnoredSubscription('livemode_subscription')
  }
  const customer = idOf(subscription.customer)
  if (!customer) {
    throw new IgnoredSubscription('subscription_without_customer')
  }
  const db = env.BILLING_DB
  // Metadata is ours (customers cannot edit it), but the customer link is the authority: an
  // account is only credited with a subscription billed to the customer we created for it.
  const claimed = subscription.metadata?.account_id
  const accountId = claimed && (await customerFor(db, claimed)) === customer ? claimed : await accountForCustomer(db, customer)
  if (!accountId) {
    throw new IgnoredSubscription('unknown_customer')
  }
  let match: ReturnType<typeof planForPrice> = null
  let seats = 1
  let overageItemId: string | null = null
  let periodStart = subscription.current_period_start
  let periodEnd = subscription.current_period_end
  for (const item of subscription.items.data) {
    if (item.price.id === env.STRIPE_PRICE_OVERAGE) {
      overageItemId = item.id
      continue
    }
    const itemPlan = planForPrice(env, item.price.id)
    if (itemPlan) {
      match = itemPlan
      seats = Math.max(1, item.quantity ?? 1)
      periodStart = item.current_period_start ?? periodStart
      periodEnd = item.current_period_end ?? periodEnd
    }
  }
  if (!match || !periodStart || !periodEnd) {
    throw new IgnoredSubscription('unrecognized_subscription_items')
  }
  await upsertSubscription(db, {
    stripe_subscription_id: subscription.id,
    account_id: accountId,
    stripe_customer_id: customer,
    status: subscription.status,
    plan: match.plan,
    seats,
    overage_enabled: overageItemId ? 1 : 0,
    current_period_start: periodStart * 1000,
    current_period_end: periodEnd * 1000,
    cancel_at_period_end: subscription.cancel_at_period_end ? 1 : 0,
    updated_at: now,
    billing_interval: match.interval,
    overage_item_id: overageItemId
  })
}

export async function handleStripeWebhook(env: Env, stripe: StripeClient, request: Request, now: number): Promise<Response> {
  const length = Number(request.headers.get('content-length') ?? '0')
  if (length > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 })
  }
  const rawBody = await request.text()
  if (rawBody.length > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 })
  }
  const verified = await verifyStripeSignature(
    rawBody,
    request.headers.get('stripe-signature'),
    splitSecrets(env.STRIPE_WEBHOOK_SECRET),
    now
  )
  if (!verified.ok) {
    return Response.json({ error: `signature_${verified.reason}` }, { status: 400 })
  }
  let event: StripeEvent
  try {
    event = JSON.parse(rawBody) as StripeEvent
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (typeof event.id !== 'string' || typeof event.type !== 'string' || !event.data?.object) {
    return Response.json({ error: 'invalid_event' }, { status: 400 })
  }
  // Acknowledged (so Stripe stops retrying) but never applied.
  if (event.livemode && !allowsLiveMode(env)) {
    return Response.json({ ignored: 'livemode' })
  }
  const subscriptionId = subscriptionIdFor(event)
  if (!subscriptionId) {
    return Response.json({ ignored: 'event_type' })
  }
  if ((await claimEvent(env.BILLING_DB, event.id, event.type, now)) === 'duplicate') {
    return Response.json({ duplicate: true })
  }
  try {
    await syncSubscription(env, stripe, subscriptionId, now)
    await finishEvent(env.BILLING_DB, event.id, { now })
    return Response.json({ received: true })
  } catch (error) {
    if (error instanceof IgnoredSubscription) {
      // Not ours or not recognizable: retrying will not help. Recorded for the audit script.
      await finishEvent(env.BILLING_DB, event.id, { now, note: error.message })
      return Response.json({ ignored: error.message })
    }
    await finishEvent(env.BILLING_DB, event.id, { error: error instanceof Error ? error.message : 'unknown' })
    // Non-2xx: Stripe retries with backoff for up to three days.
    return Response.json({ error: 'processing_failed' }, { status: 500 })
  }
}
