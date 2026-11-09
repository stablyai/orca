// Overage is opt-in per account (off by default) with a monthly spend cap admins can raise.
// Opting in adds the metered overage price to the Stripe subscription (once); opting out stops
// metering immediately but leaves the item, so usage already reported is still invoiced.
import { z } from 'zod'
import type { BillingCaller } from './auth'
import { OPEN_STATUSES } from './checkout'
import type { Env } from './env'
import { planCatalog } from './plans'
import type { StripeClient } from './stripe'
import { accountSettings, currentSubscription, setOverageSettings, upsertSubscription } from './store'

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
  if (request.enabled && !subscription.overage_item_id) {
    // Idempotent per subscription+price, so a retried opt-in cannot add a second item.
    const item = await stripe.addSubscriptionItem({ subscription: subscription.stripe_subscription_id, price: env.STRIPE_PRICE_OVERAGE })
    await upsertSubscription(env.BILLING_DB, { ...subscription, overage_enabled: 1, overage_item_id: item.id, updated_at: now })
  }
  // An omitted cap keeps the current one; null restores the plan default.
  const spendCapCents =
    request.spendCapCents === undefined
      ? (await accountSettings(env.BILLING_DB, caller.accountId)).spend_cap_cents
      : request.spendCapCents
  await setOverageSettings(env.BILLING_DB, caller.accountId, { optIn: request.enabled, spendCapCents }, now)
  return { ok: true }
}
