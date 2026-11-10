// Overage is opt-in per account (off by default) with a monthly spend cap admins can raise.
// Opting in puts exactly one metered overage item, at STRIPE_PRICE_OVERAGE, on the Stripe
// subscription: an item still on an older overage price is moved to the current one rather than a
// second added (two items on the same meter would bill the same seconds twice). Opting out stops
// metering immediately but leaves the item, so usage already reported is still invoiced.
import { z } from 'zod'
import type { BillingCaller } from './auth'
import { OPEN_STATUSES } from './checkout'
import type { Env } from './env'
import { planCatalog, planForPrice } from './plans'
import type { StripeClient, StripeSubscription } from './stripe'
import { accountSettings, currentSubscription, setOverageSettings, upsertSubscription, type SubscriptionRow } from './store'

export const OverageRequestSchema = z
  .object({
    enabled: z.boolean(),
    // Whole cents; null restores the plan default.
    spendCapCents: z.number().int().min(0).nullable().optional()
  })
  .strict()

export type OverageOutcome = { ok: true } | { ok: false; status: number; error: string }

export async function updateOverage(
  env: Env,
  stripe: StripeClient,
  caller: BillingCaller,
  request: z.infer<typeof OverageRequestSchema>,
  now: number
): Promise<OverageOutcome> {
  if (!caller.canManage) {
    return { ok: false, status: 403, error: 'billing_admin_required' }
  }
  const team = planCatalog(env).team
  if (request.spendCapCents != null && request.spendCapCents > team.maxSpendCapCents) {
    return { ok: false, status: 400, error: 'spend_cap_too_high' }
  }
  const subscription = await currentSubscription(env.BILLING_DB, caller.accountId)
  if (!subscription || !OPEN_STATUSES.has(subscription.status)) {
    return { ok: false, status: 409, error: 'no_subscription' }
  }
  if (request.enabled) {
    const itemId = await ensureOverageItem(env, stripe, subscription)
    if (itemId !== subscription.overage_item_id) {
      await upsertSubscription(env.BILLING_DB, { ...subscription, overage_enabled: 1, overage_item_id: itemId, updated_at: now })
    }
  }
  // An omitted cap keeps the current one; null restores the plan default.
  const spendCapCents =
    request.spendCapCents === undefined
      ? (await accountSettings(env.BILLING_DB, caller.accountId)).spend_cap_cents
      : request.spendCapCents
  await setOverageSettings(env.BILLING_DB, caller.accountId, { optIn: request.enabled, spendCapCents }, now)
  return { ok: true }
}

/** A metered item that is not a seat price and not the current overage price: an older overage price. */
function isStaleOverageItem(env: Env, item: StripeSubscription['items']['data'][number]): boolean {
  return (
    item.price.id !== env.STRIPE_PRICE_OVERAGE &&
    planForPrice(env, item.price.id) === null &&
    item.price.recurring?.usage_type === 'metered'
  )
}

/** The subscription's one overage item at the current price, creating or re-pricing it as needed. */
async function ensureOverageItem(env: Env, stripe: StripeClient, subscription: SubscriptionRow): Promise<string> {
  // Stripe is the source of truth for the items: the stored id can be missing or on an old price.
  const live = await stripe.retrieveSubscription(subscription.stripe_subscription_id)
  const current = live.items.data.find((item) => item.price.id === env.STRIPE_PRICE_OVERAGE)
  const stale = live.items.data.filter((item) => isStaleOverageItem(env, item))
  if (current) {
    // Never leave a second metered item on the same meter.
    for (const item of stale) {
      await stripe.deleteSubscriptionItem(item.id)
    }
    return current.id
  }
  const [replace, ...extra] = stale
  if (replace) {
    await stripe.setSubscriptionItemPrice({ item: replace.id, price: env.STRIPE_PRICE_OVERAGE })
    for (const item of extra) {
      await stripe.deleteSubscriptionItem(item.id)
    }
    return replace.id
  }
  // Idempotent per subscription+price, so a retried opt-in cannot add a second item.
  return (await stripe.addSubscriptionItem({ subscription: subscription.stripe_subscription_id, price: env.STRIPE_PRICE_OVERAGE })).id
}
