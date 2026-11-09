// Hosted Checkout and Customer Portal sessions. Card data only ever touches Stripe's pages.
import { z } from 'zod'
import type { BillingCaller } from './auth'
import type { Env } from './env'
import { PLAN_IDS, priceForPlan, type PlanId } from './plans'
import type { StripeClient } from './stripe'
import { currentSubscription, customerFor, ensureAccount, linkCustomer } from './store'

export const MAX_TEAM_SEATS = 500

export const CheckoutRequestSchema = z
  .object({
    plan: z.enum(PLAN_IDS),
    seats: z.number().int().min(1).max(MAX_TEAM_SEATS).optional()
  })
  .strict()

const OPEN_STATUSES = new Set(['active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused'])

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
  request: { plan: PlanId; seats?: number },
  now: number
): Promise<CheckoutOutcome> {
  if (!caller.canManage) {
    return { ok: false, status: 403, error: 'billing_admin_required' }
  }
  const existing = await currentSubscription(env.BILLING_DB, caller.accountId)
  if (existing && OPEN_STATUSES.has(existing.status)) {
    // Plan changes and seat changes go through the portal, which prorates; a second
    // subscription would double-bill.
    return { ok: false, status: 409, error: 'already_subscribed' }
  }
  const seats = request.plan === 'team' ? (request.seats ?? 1) : 1
  const customer = await ensureCustomer(env, stripe, caller, now)
  const trialDays = Number(env.STRIPE_TRIAL_DAYS ?? '0')
  const session = await stripe.createCheckoutSession(
    {
      mode: 'subscription',
      customer,
      client_reference_id: caller.accountId,
      line_items: [{ price: priceForPlan(env, request.plan), quantity: seats }, { price: env.STRIPE_PRICE_OVERAGE }],
      // No free plan: a card is collected even for a trial.
      payment_method_collection: 'always',
      allow_promotion_codes: true,
      customer_update: { address: 'auto', name: 'auto' },
      success_url: returnUrl(env, { checkout: 'success', session_id: 'CHECKOUT_SESSION_ID_PLACEHOLDER' }),
      cancel_url: returnUrl(env, { checkout: 'cancel' }),
      metadata: { account_id: caller.accountId, plan: request.plan },
      subscription_data: {
        metadata: { account_id: caller.accountId, plan: request.plan },
        trial_period_days: Number.isInteger(trialDays) && trialDays > 0 ? trialDays : undefined
      }
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
    { customer, returnUrl: returnUrl(env, { portal: 'return' }) },
    `portal:${caller.accountId}:${crypto.randomUUID()}`
  )
  return { ok: true, url: session.url }
}
