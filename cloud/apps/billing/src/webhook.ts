// Stripe webhook: verify the signature over the raw body, dedupe by event id, then re-read the
// subscription from the API instead of trusting the (possibly stale, possibly out-of-order) payload.
import type { Env } from './env'
import { StripeError, allowsLiveMode, type StripeClient, type StripeSubscription } from './stripe'
import {
  accountForCustomer,
  claimEvent,
  currentSubscription,
  customerFor,
  finishEvent,
  subscriptionById,
  subscriptionsForCustomer,
  upsertSubscription,
  type SubscriptionRow
} from './store'
import { entitlementsMode } from './entitlements-mode'
import { loadCatalog } from './catalog'
import { pushBillingAudit, subscriptionAuditEvents } from './audit-push'
import { projectSubscription } from './grants'
import { catalogIfApplied, isOveragePrice, recordSubscriptionPrices, seatPriceMatch, syncCatalogPrices, type PriceMatch } from './catalog-sync'
import type { StripePrice } from './stripe'
import { retireOverageItem } from './overage'
import { splitSecrets, verifyStripeSignature } from './webhook-signature'

const MAX_BODY_BYTES = 512 * 1024

export type StripeEvent = {
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
// The catalog's prices changed in Stripe: re-sync plan_prices (catalog-sync.ts).
const CATALOG_EVENTS = new Set(['price.created', 'price.updated', 'price.deleted', 'product.updated'])
const CUSTOMER_DELETED = 'customer.deleted'

/** Every event type billing acts on (the webhook endpoint's list and the reconciliation replay). */
export const HANDLED_EVENT_TYPES = [
  'checkout.session.completed',
  ...SUBSCRIPTION_EVENTS,
  ...INVOICE_EVENTS,
  ...CATALOG_EVENTS,
  CUSTOMER_DELETED
]

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

/** Stripe statuses after a failed renewal: past_due while retrying, unpaid once retries are exhausted. */
export const PAYMENT_FAILED_STATUSES = new Set(['past_due', 'unpaid'])

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
  const catalog = await catalogIfApplied(db, now)
  let match: PriceMatch | null = null
  let seatPrice: StripePrice | null = null
  let seats = 1
  let overageItemId: string | null = null
  let periodStart = subscription.current_period_start
  let periodEnd = subscription.current_period_end
  for (const item of subscription.items.data) {
    if (isOveragePrice(env, catalog, item.price)) {
      overageItemId = item.id
      continue
    }
    const itemPlan = seatPriceMatch(env, catalog, item.price)
    if (itemPlan) {
      match = itemPlan
      seatPrice = item.price
      seats = Math.max(1, item.quantity ?? 1)
      periodStart = item.current_period_start ?? periodStart
      periodEnd = item.current_period_end ?? periodEnd
    }
  }
  const known = await subscriptionById(db, subscription.id)
  if (!match && known) {
    // A subscriber we already bill, on a price we can't map (it was replaced in Stripe before we
    // ever saw it): never freeze them on stale Stripe state. Status, period and cancellation still
    // apply, so a cancel still revokes; plan, interval and seats stay as last known.
    console.error(JSON.stringify({ error: 'unrecognized_subscription_items', subscription: subscription.id, known: true }))
    match = { plan: known.plan, interval: known.billing_interval }
    seats = known.seats
    periodStart = periodStart ?? subscription.items.data[0]?.current_period_start ?? known.current_period_start / 1000
    periodEnd = periodEnd ?? subscription.items.data[0]?.current_period_end ?? known.current_period_end / 1000
  }
  if (!match || !periodStart || !periodEnd) {
    throw new IgnoredSubscription('unrecognized_subscription_items')
  }
  if (catalog && seatPrice) {
    await recordSubscriptionPrices(db, catalog, [{ price: seatPrice, match }], now).catch((error: unknown) => {
      console.error(JSON.stringify({ error: 'record_subscription_price', message: error instanceof Error ? error.message.slice(0, 200) : '' }))
    })
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
    overage_item_id: overageItemId,
    // The upsert keeps the earliest value while it stays unpaid and clears it once paid.
    past_due_since: PAYMENT_FAILED_STATUSES.has(subscription.status) ? now : null,
    // Membership comes from auth, not Stripe: keep the stored count.
    member_count: null,
    seat_price_id: seatPrice?.id ?? null
  })
  await projectGrants(env, subscription.id, now)
  // The team's audit log: plan started, changed or canceled, seats, a scheduled cancellation.
  await pushBillingAudit(
    env,
    accountId,
    subscriptionAuditEvents(
      known,
      { status: subscription.status, plan: match.plan, billing_interval: match.interval, seats, cancel_at_period_end: subscription.cancel_at_period_end ? 1 : 0 },
      now
    )
  )
  if (overageItemId) {
    // An opted-out account's overage item goes once the period it was used in has been invoiced.
    const stored = await currentSubscription(db, accountId)
    if (stored?.stripe_subscription_id === subscription.id) {
      await retireOverageItem(env, stripe, stored, now).catch((error: unknown) => {
        console.error(JSON.stringify({ error: 'retire_overage_item', message: error instanceof Error ? error.message.slice(0, 200) : '' }))
      })
    }
  }
}

/** Re-projects the subscription's entitlement grants from the row just written (grants.ts). */
async function projectGrants(env: Env, subscriptionId: string, now: number): Promise<void> {
  const mode = entitlementsMode(env)
  if (mode === 'off') {
    return
  }
  try {
    const row = await subscriptionById(env.BILLING_DB, subscriptionId)
    if (row) {
      await projectSubscription(env.BILLING_DB, await loadCatalog(env.BILLING_DB, now), row, now, 'stripe_webhook')
    }
  } catch (error) {
    if (mode === 'on') {
      // Stripe retries; the reconciliation sweep and the lazy read path heal it too.
      throw error
    }
    console.error(JSON.stringify({ error: 'grant_projection', message: error instanceof Error ? error.message.slice(0, 200) : '' }))
  }
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
  const outcome = await processStripeEvent(env, stripe, event, now)
  return Response.json(outcome.body, { status: outcome.status })
}

/**
 * Applies one Stripe event: the webhook's path and the reconciliation replay's. Deduped by event
 * id; the subscription (or customer, or catalog) is re-read from Stripe, never taken from the payload.
 */
export async function processStripeEvent(
  env: Env,
  stripe: StripeClient,
  event: StripeEvent,
  now: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Acknowledged (so Stripe stops retrying) but never applied.
  if (event.livemode && !allowsLiveMode(env)) {
    return { status: 200, body: { ignored: 'livemode' } }
  }
  const subscriptionId = subscriptionIdFor(event)
  const customerId = event.type === CUSTOMER_DELETED ? idOf(event.data.object.id) : null
  const catalogEvent = CATALOG_EVENTS.has(event.type)
  if (!subscriptionId && !customerId && !catalogEvent) {
    return { status: 200, body: { ignored: 'event_type' } }
  }
  if ((await claimEvent(env.BILLING_DB, event.id, event.type, now)) === 'duplicate') {
    return { status: 200, body: { duplicate: true } }
  }
  try {
    if (subscriptionId) {
      await syncSubscription(env, stripe, subscriptionId, now)
    } else if (customerId) {
      await endCustomerSubscriptions(env, customerId, now)
    } else {
      const result = await syncCatalogPrices(env, stripe, now)
      if (result.error && result.error !== 'catalog_unavailable') {
        throw new Error(`catalog_sync_${result.error}`)
      }
    }
    await finishEvent(env.BILLING_DB, event.id, { now })
    return { status: 200, body: { received: true } }
  } catch (error) {
    if (error instanceof IgnoredSubscription) {
      // Not ours or not recognizable: retrying will not help. Recorded for the audit script.
      await finishEvent(env.BILLING_DB, event.id, { now, note: error.message })
      return { status: 200, body: { ignored: error.message } }
    }
    await finishEvent(env.BILLING_DB, event.id, { error: error instanceof Error ? error.message : 'unknown' })
    // Non-2xx: Stripe retries with backoff for up to three days.
    return { status: 500, body: { error: 'processing_failed' } }
  }
}

/**
 * A deleted Stripe customer takes its subscriptions with it (Stripe cancels them, and a deleted
 * subscription can't be read back): mark every one we hold for it canceled and revoke the grants.
 */
export async function endCustomerSubscriptions(env: Env, customerId: string, now: number): Promise<number> {
  const rows = await subscriptionsForCustomer(env.BILLING_DB, customerId)
  let ended = 0
  for (const row of rows) {
    if (row.status === 'canceled') {
      continue
    }
    await markCanceled(env, row, now)
    ended++
  }
  return ended
}

async function markCanceled(env: Env, row: SubscriptionRow, now: number): Promise<void> {
  await upsertSubscription(env.BILLING_DB, { ...row, status: 'canceled', past_due_since: null, member_count: null, updated_at: now })
  await projectGrants(env, row.stripe_subscription_id, now)
  await pushBillingAudit(env, row.account_id, subscriptionAuditEvents(row, { ...row, status: 'canceled' }, now))
}

/**
 * Re-reads one subscription we hold (reconciliation). A subscription Stripe no longer has (its
 * customer was deleted) is canceled here. Returns what happened, for the cron summary.
 */
export async function resyncSubscription(
  env: Env,
  stripe: StripeClient,
  row: SubscriptionRow,
  now: number
): Promise<'synced' | 'canceled_missing' | 'ignored'> {
  try {
    await syncSubscription(env, stripe, row.stripe_subscription_id, now)
    return 'synced'
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) {
      await markCanceled(env, row, now)
      return 'canceled_missing'
    }
    if (error instanceof IgnoredSubscription) {
      return 'ignored'
    }
    throw error
  }
}
