// Hosted Checkout and Customer Portal sessions. Card data only ever touches Stripe's pages.
import { z } from 'zod'
import type { BillingCaller } from './auth'
import type { Env } from './env'
import { BILLING_INTERVALS, PLAN_IDS, priceForPlan, type BillingInterval, type PlanId } from './plans'
import { StripeError, assertKeyMode, type StripeClient } from './stripe'
import { currentSubscription, customerFor, ensureAccount, linkCustomer } from './store'
import { orgIdOf, type MembershipSource } from './membership'
import { setupCheckoutReturnUrls } from './cloud-setup-urls'
import { accountTerms } from './entitlements'
import { entitlementsMode } from './entitlements-mode'
import { loadCatalog } from './catalog'
import { checkoutPrice } from './catalog-sync'

export const MAX_TEAM_SEATS = 500

export const CheckoutRequestSchema = z
  .object({
    plan: z.enum(PLAN_IDS),
    interval: z.enum(BILLING_INTERVALS).default('month'),
    seats: z.number().int().min(1).max(MAX_TEAM_SEATS).default(1),
    // The in-app plans dialog joins an open setup session: Checkout returns to its next step.
    setupSessionId: z.string().regex(/^cs_[A-Za-z0-9_-]{22}$/).optional()
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
  membership: MembershipSource,
  options: { setupSessionId?: string } = {}
): Promise<CheckoutOutcome> {
  if (!caller.canManage) {
    return { ok: false, status: 403, error: 'billing_admin_required' }
  }
  // O1/N4: every Checkout lands on a team. A personal account's subscription could never move to
  // a team later (the account id is the billing key), so the desktop creates the team first.
  if (!caller.accountId.startsWith('org:')) {
    return { ok: false, status: 409, error: 'team_required' }
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
  const terms = await accountTerms(env, caller.accountId, now)
  if (seats > terms.maxSeats) {
    return { ok: false, status: 400, error: 'too_many_seats' }
  }
  // A misconfigured (live) key fails first, whatever the catalog says.
  assertKeyMode(env)
  const price = await seatPriceFor(env, request.plan, request.interval, now)
  if (!price) {
    // ENTITLEMENTS_MODE=on and Stripe has no price holding this plan's lookup key (yet): never
    // sell at a guessed price.
    return { ok: false, status: 409, error: 'plan_unavailable' }
  }
  const customer = await ensureCustomer(env, stripe, caller, now)
  // One live Checkout per account: a reopened or retried checkout expires the earlier page, so
  // two browser tabs can never both be paid into two subscriptions. A session that can no longer
  // be expired is completing right now; treat the account as subscribed.
  const open = await stripe.listOpenCheckoutSessions(customer)
  for (const session of open.data) {
    try {
      await stripe.expireCheckoutSession(session.id)
    } catch (error) {
      // Only "no longer open" means it's completing; outages stay errors (503, try again).
      if (error instanceof StripeError && error.status === 400) {
        return { ok: false, status: 409, error: 'already_subscribed' }
      }
      throw error
    }
  }
  const metadata = {
    account_id: caller.accountId,
    plan: request.plan,
    interval: request.interval,
    ...(options.setupSessionId ? { setup_session_id: options.setupSessionId } : {})
  }
  const setupReturn = options.setupSessionId ? setupCheckoutReturnUrls(env, options.setupSessionId) : null
  const session = await stripe.createCheckoutSession(
    {
      mode: 'subscription',
      customer,
      client_reference_id: caller.accountId,
      // Seats only. Overage is opt-in later; its metered item is added then (overage.ts).
      line_items: [
        // Seats then follow org membership automatically (seats.ts); not editable on the page.
        { price, quantity: seats }
      ],
      payment_method_collection: 'always',
      allow_promotion_codes: true,
      customer_update: { address: 'auto', name: 'auto' },
      success_url:
        setupReturn?.success ?? returnUrl(env, { checkout: 'success', session_id: 'CHECKOUT_SESSION_ID_PLACEHOLDER' }),
      cancel_url: setupReturn?.cancel ?? returnUrl(env, { checkout: 'cancel' }),
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

/** The seat price Checkout sells: the catalog's lookup-key holder when on, else the env price id. */
async function seatPriceFor(env: Env, plan: PlanId, interval: BillingInterval, now: number): Promise<string | null> {
  if (entitlementsMode(env) !== 'on') {
    return priceForPlan(env, interval)
  }
  const catalog = await loadCatalog(env.BILLING_DB, now)
  return checkoutPrice(catalog, plan, interval)?.stripe_price_id ?? null
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
