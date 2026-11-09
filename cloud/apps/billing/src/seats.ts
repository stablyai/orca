// Team seats follow org membership: seats = members (pending invites excluded), minimum 1.
// Membership is owned by Orca Cloud auth, which reports it either by pushing
// (POST /v1/internal/seats) or in the billing token's `orgMembers` claim.
//
// Proration (Stripe's model, documented in cloud/docs/accounts-billing-design.md):
// - Adding seats: `always_invoice` - the prorated amount for the rest of the period is invoiced and
//   charged now (on annual plans this avoids a seat being free until renewal).
// - Removing seats: `create_prorations` - Stripe's default; the unused time becomes a credit on
//   the next invoice. Nothing is refunded to the card.
import { z } from 'zod'
import { OPEN_STATUSES } from './checkout'
import type { Env } from './env'
import { MAX_TEAM_SEATS } from './checkout'
import { planForPrice } from './plans'
import type { StripeClient } from './stripe'
import { currentSubscription, openOrgAccounts } from './store'
import { orgIdOf, type MembershipSource } from './membership'
import { syncSubscription } from './webhook'

export const SeatSyncSchema = z
  .object({
    accountId: z.string().min(1).max(128).regex(/^org:[A-Za-z0-9_.:-]+$/),
    members: z.number().int().min(0).max(100_000)
  })
  .strict()

export type SeatSyncOutcome =
  | { status: 'unchanged'; seats: number }
  | { status: 'updated'; seats: number; previous: number }
  | { status: 'no_subscription' }
  | { status: 'too_many_seats' }

export async function syncSeats(
  env: Env,
  stripe: StripeClient,
  accountId: string,
  members: number,
  now: number
): Promise<SeatSyncOutcome> {
  const subscription = await currentSubscription(env.BILLING_DB, accountId)
  if (!subscription || !OPEN_STATUSES.has(subscription.status)) {
    return { status: 'no_subscription' }
  }
  const desired = Math.max(1, members)
  if (desired > MAX_TEAM_SEATS) {
    return { status: 'too_many_seats' }
  }
  if (desired === subscription.seats) {
    return { status: 'unchanged', seats: desired }
  }
  // Read the live item: the mirror can lag a webhook, and the item id is not stored.
  const live = await stripe.retrieveSubscription(subscription.stripe_subscription_id)
  const seatItem = live.items.data.find((item) => planForPrice(env, item.price.id))
  if (!seatItem) {
    return { status: 'no_subscription' }
  }
  const current = seatItem.quantity ?? 1
  if (current !== desired) {
    await stripe.setSubscriptionItemQuantity({
      item: seatItem.id,
      quantity: desired,
      prorationBehavior: desired > current ? 'always_invoice' : 'create_prorations',
      // Same change retried within Stripe's idempotency window is applied once.
      idempotencyKey: `seats:${seatItem.id}:${current}->${desired}`
    })
  }
  await syncSubscription(env, stripe, subscription.stripe_subscription_id, now)
  return { status: 'updated', seats: desired, previous: current }
}

/** Cron: re-read every open org's member count from auth and fix any drift (a missed push). */
export async function reconcileSeats(
  env: Env,
  stripe: StripeClient,
  membership: MembershipSource,
  now: number
): Promise<{ checked: number; updated: number; failed: number }> {
  let checked = 0
  let updated = 0
  let failed = 0
  for (const accountId of await openOrgAccounts(env.BILLING_DB, 200)) {
    const orgId = orgIdOf(accountId)
    if (!orgId) {
      continue
    }
    try {
      const members = await membership(orgId)
      if (members === null) {
        return { checked, updated, failed }
      }
      checked++
      const outcome = await syncSeats(env, stripe, accountId, members, now)
      if (outcome.status === 'updated') {
        updated++
      }
    } catch {
      failed++
    }
  }
  return { checked, updated, failed }
}
