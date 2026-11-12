// Overage is opt-in per account (off by default) with a monthly spend cap admins can raise.
// Opting in puts exactly one metered overage item, at STRIPE_PRICE_OVERAGE, on the Stripe
// subscription: an item still on an older overage price is moved to the current one rather than a
// second added (two items on the same meter would bill the same seconds twice). Opting out stops
// metering immediately. The item is removed once it has nothing left to invoice (no meter report
// this Stripe period): at once if none was sent, otherwise at a sync after the period rolls over,
// so usage already reported is still invoiced and no $0 overage line is left on later invoices.
import { z } from 'zod'
import type { BillingCaller } from './auth'
import { OPEN_STATUSES } from './checkout'
import type { Env } from './env'
import { planForPrice } from './plans'
import { accountTerms } from './entitlements'
import type { StripeClient, StripeSubscription } from './stripe'
import {
  accountSettings,
  currentSubscription,
  meterReportsSince,
  setOverageSettings,
  upsertSubscription,
  type SubscriptionRow
} from './store'

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
  const terms = await accountTerms(env, caller.accountId, now)
  if (request.spendCapCents != null && request.spendCapCents > terms.maxSpendCapCents) {
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
  if (!request.enabled) {
    // Best effort: the opt-out already stops metering; a failed removal is retried by the next sync.
    await retireOverageItem(env, stripe, subscription, now).catch((error: unknown) => {
      console.error(JSON.stringify({ error: 'retire_overage_item', message: error instanceof Error ? error.message.slice(0, 200) : '' }))
    })
  }
  return { ok: true }
}

/**
 * Removes an opted-out account's overage item once nothing on it is left to invoice: no meter
 * report (sent or pending) since the Stripe period began. Returns whether it removed one.
 */
export async function retireOverageItem(env: Env, stripe: StripeClient, subscription: SubscriptionRow, now: number): Promise<boolean> {
  if (!subscription.overage_item_id) {
    return false
  }
  const settings = await accountSettings(env.BILLING_DB, subscription.account_id)
  if (settings.overage_opt_in === 1) {
    return false
  }
  if ((await meterReportsSince(env.BILLING_DB, subscription.account_id, subscription.current_period_start)) > 0) {
    return false
  }
  await stripe.deleteSubscriptionItem(subscription.overage_item_id)
  await upsertSubscription(env.BILLING_DB, { ...subscription, overage_enabled: 0, overage_item_id: null, updated_at: now })
  return true
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
  // Idempotent per subscription+price, so a retried opt-in cannot add a second item. Opting out
  // can remove the item, so a later opt-in may get the removed item's id replayed (Stripe keeps
  // idempotent answers for 24 hours): then add again under a key that names the removed item.
  let after: string | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    const added = await stripe.addSubscriptionItem({ subscription: subscription.stripe_subscription_id, price: env.STRIPE_PRICE_OVERAGE, after })
    const fresh = await stripe.retrieveSubscription(subscription.stripe_subscription_id)
    if (fresh.items.data.some((item) => item.id === added.id)) {
      return added.id
    }
    after = added.id
  }
  throw new Error('overage_item_replayed')
}
