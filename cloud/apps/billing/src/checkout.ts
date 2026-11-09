// Hosted Checkout and Customer Portal sessions. Card data only ever touches Stripe's pages.
import { z } from 'zod'
import type { BillingCaller } from './auth'
import type { Env } from './env'
import { BILLING_INTERVALS, PLAN_IDS, priceForPlan, type BillingInterval, type PlanId } from './plans'
import type { StripeClient } from './stripe'
import { currentSubscription, customerFor, ensureAccount, linkCustomer } from './store'
import { orgIdOf, type MembershipSource } from './membership'

export const MAX_TEAM_SEATS = 500

export const CheckoutRequestSchema = z
  .object({
    plan: z.enum(PLAN_IDS),
    interval: z.enum(BILLING_INTERVALS).default('month'),
    seats: z.number().int().min(1).max(MAX_TEAM_SEATS).default(1)
  })
  .strict()

export const OPEN_STATUSES = new Set(['active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused'])

export type CheckoutOutcome = { ok: true; url: string } | { ok: false; status: number; error: string }

function returnUrl(env: Env, params: Record<string, string>): string {
  const url = new URL(env.BILLING_RETURN_URL)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  // Stripe substitutes this literal placeholder; URLSearchParams would percent-encode the braces.
  return url.toString().replace('CHECKOUT_SESSION_ID_PLACEHOLDER', '{CHECKOUT_SESSION_ID}')
}

async function ensureCustomer(env: Env, stripe: StripeClient, caller: BillingCaller, now: number): Promise<string> {
  await ensureAccount(env.BILLING_DB, caller.accountId, now)
  const existing = await customerFor(env.BILLING_DB, caller.accountId)
  if (existing) {
    return existing
  }
  const created = await stripe.createCustomer({ accountId: caller.accountId, email: caller.email })
  return linkCustomer(env.BILLING_DB, caller.accountId, created.id, now)
}

export async function createCheckout(
  env: Env,
  stripe: StripeClient,
  caller: BillingCaller,
  request: { plan: PlanId; interval: BillingInterval; seats: number },
  now: number,
  membership: MembershipSource
): Promise<CheckoutOutcome> {
  if (!caller.canManage) {
    return { ok: false, status: 403, error: 'billing_admin_required' }
  }
  const existing = await currentSubscription(env.BILLING_DB, caller.accountId)
  if (existing && OPEN_STATUSES.has(existing.status)) {
    // Seat and interval changes go through the portal, which prorates; a second subscription
    // would double-bill.
    return { ok: false, status: 409, error: 'already_subscribed' }
  }
  // Seats = org members from auth when it is reachable; never fewer than 1. Throws (-> 503) if
  // auth is configured but unavailable rather than guessing a seat count.
  const orgId = orgIdOf(caller.accountId)
  const live = orgId ? await membership(orgId) : null
  const seats = Math.max(1, live ?? request.seats)
  const customer = await ensureCustomer(env, stripe, caller, now)
  // One live Checkout per account: a reopened or retried checkout expires the earlier page, so
  // two browser tabs can never both be paid into two subscriptions. A session that can no longer
  // be expired is completing right now; treat the account as subscribed.
  const open = await stripe.listOpenCheckoutSessions(customer)
  for (const session of open.data) {
    try {
      await stripe.expireCheckoutSession(session.id)
    } catch {
      return { ok: false, status: 409, error: 'already_subscribed' }
    }
  }
  const metadata = { account_id: caller.accountId, plan: request.plan, interval: request.interval }
  const session = await stripe.createCheckoutSession(
    {
      mode: 'subscription',
      customer,
      client_reference_id: caller.accountId,
      // Seats only. Overage is opt-in later; its metered item is added then (overage.ts).
      line_items: [
        // Seats then follow org membership automatically (seats.ts); not editable on the page.
        { price: priceForPlan(env, request.interval), quantity: seats }
      ],
      payment_method_collection: 'always',
      allow_promotion_codes: true,
      customer_update: { address: 'auto', name: 'auto' },
      success_url: returnUrl(env, { checkout: 'success', session_id: 'CHECKOUT_SESSION_ID_PLACEHOLDER' }),
      cancel_url: returnUrl(env, { checkout: 'cancel' }),
      metadata,
      ...(env.STRIPE_AUTOMATIC_TAX === 'true'
        ? { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true } }
        : {}),
      subscription_data: { metadata }
    },
    `checkout:${caller.accountId}:${crypto.randomUUID()}`
  )
  return { ok: true, url: session.url }
}

export async function createPortal(env: Env, stripe: StripeClient, caller: BillingCaller): Promise<CheckoutOutcome> {
  if (!caller.canManage) {
    return { ok: false, status: 403, error: 'billing_admin_required' }
  }
  const customer = await customerFor(env.BILLING_DB, caller.accountId)
  if (!customer) {
    return { ok: false, status: 404, error: 'no_billing_account' }
  }
  const session = await stripe.createPortalSession(
    { customer, returnUrl: returnUrl(env, { portal: 'return' }), configuration: env.STRIPE_PORTAL_CONFIGURATION },
    `portal:${caller.accountId}:${crypto.randomUUID()}`
  )
  return { ok: true, url: session.url }
}
