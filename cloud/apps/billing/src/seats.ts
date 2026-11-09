// Team seats follow org membership, billed by the period's PEAK (the GitHub model, with peak
// protection against remove/re-add churn):
//
// - Adding members above the seats already paid this period: the extra seats are invoiced and
//   charged now, prorated (`always_invoice`).
// - Removing members: nothing changes mid-period (no credit). Seats come down to the current
//   member count only at renewal: inside `seatTrueDownHours` of the period end, billing lowers the
//   quantity with `proration_behavior: none`, so the renewal invoice bills the smaller team.
// - Re-adding someone removed earlier in the same period costs nothing: the period's seats are
//   never lowered mid-period, so membership up to the peak is already paid.
//
// Membership is owned by Orca Cloud auth (pull: /v1/internal/billing/org-members; push:
// /v1/internal/seats). Seats are never below 1. See cloud/docs/accounts-billing-design.md.
import { z } from 'zod'
import { MAX_TEAM_SEATS, OPEN_STATUSES } from './checkout'
import type { Env } from './env'
import { orgIdOf, type MembershipSource } from './membership'
import { planCatalog, planForPrice } from './plans'
import type { StripeClient } from './stripe'
import { currentSubscription, openOrgAccounts, setMemberCount } from './store'
import { syncSubscription } from './webhook'

export const SeatSyncSchema = z
  .object({
    accountId: z.string().min(1).max(128).regex(/^org:[A-Za-z0-9_.:-]+$/),
    members: z.number().int().min(0).max(100_000)
  })
  .strict()

export type SeatSyncOutcome =
  | { status: 'unchanged'; seats: number }
  | { status: 'increased'; seats: number; previous: number }
  /** Fewer members than paid seats: the paid seats stay until renewal. */
  | { status: 'deferred'; seats: number; members: number; effectiveAt: number }
  /** Lowered for the renewal invoice (no credit for the current period). */
  | { status: 'reduced_at_renewal'; seats: number; previous: number; effectiveAt: number }
  | { status: 'no_subscription' }
  | { status: 'too_many_seats' }

export async function syncSeats(
  env: Env,
  stripe: StripeClient,
  accountId: string,
  members: number,
  now: number
): Promise<SeatSyncOutcome> {
  const db = env.BILLING_DB
  const subscription = await currentSubscription(db, accountId)
  if (!subscription || !OPEN_STATUSES.has(subscription.status)) {
    return { status: 'no_subscription' }
  }
  const desired = Math.max(1, members)
  if (desired > MAX_TEAM_SEATS) {
    return { status: 'too_many_seats' }
  }
  // Remembered so the reconcile cron can apply a deferred decrease without a fresh push.
  await setMemberCount(db, subscription.stripe_subscription_id, members, now)
  if (desired === subscription.seats) {
    return { status: 'unchanged', seats: desired }
  }
  const periodEnd = subscription.current_period_end
  const trueDownFrom = periodEnd - planCatalog(env).team.seatTrueDownHours * 3600_000
  if (desired < subscription.seats && now < trueDownFrom) {
    return { status: 'deferred', seats: subscription.seats, members: desired, effectiveAt: periodEnd }
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
      prorationBehavior: desired > current ? 'always_invoice' : 'none',
      // Same change retried within Stripe's idempotency window is applied once.
      idempotencyKey: `seats:${seatItem.id}:${periodEnd}:${current}->${desired}`
    })
  }
  await syncSubscription(env, stripe, subscription.stripe_subscription_id, now)
  return desired > current
    ? { status: 'increased', seats: desired, previous: current }
    : { status: 'reduced_at_renewal', seats: desired, previous: current, effectiveAt: periodEnd }
}

/**
 * Cron: brings every open org's seats in line with membership. Re-reads the count from auth when
 * configured (catching invites accepted at the provider); otherwise uses the last pushed count.
 * Also where deferred decreases land, once a subscription is inside its true-down window.
 */
export async function reconcileSeats(
  env: Env,
  stripe: StripeClient,
  membership: MembershipSource,
  now: number
): Promise<{ checked: number; changed: number; failed: number }> {
  let checked = 0
  let changed = 0
  let failed = 0
  for (const { account_id: accountId, member_count: stored } of await openOrgAccounts(env.BILLING_DB, 200)) {
    const orgId = orgIdOf(accountId)
    if (!orgId) {
      continue
    }
    try {
      const members = (await membership(orgId)) ?? stored
      if (members === null) {
        continue
      }
      checked++
      const outcome = await syncSeats(env, stripe, accountId, members, now)
      if (outcome.status === 'increased' || outcome.status === 'reduced_at_renewal') {
        changed++
      }
    } catch {
      failed++
    }
  }
  return { checked, changed, failed }
}
