// Auth's team delete (TEAM-DELETE, EP-10) asks billing about the team's subscription and, for a
// subscription that is already set to end, cancels it now so the team can go. Both routes take
// the membership-sync token (auth -> billing), never a desktop token.
//   GET  /v1/internal/accounts/:accountId/subscription            -> state for the delete check
//   POST /v1/internal/accounts/:accountId/subscription/cancel-now -> cancel a cancelling one now
import { OPEN_STATUSES } from './checkout'
import type { Env } from './env'
import { StripeError, type StripeClient } from './stripe'
import { currentSubscription } from './store'
import { resyncSubscription } from './webhook'

export type TeamSubscriptionView = {
  status: string | null
  open: boolean
  /** Set to end (cancel at period end, or a portal cancel date): deleting can cancel it now. */
  cancelling: boolean
  /** When it would end on its own (epoch ms); null when not cancelling. */
  endsAt: number | null
  periodEnd: number | null
}

export async function teamSubscriptionView(env: Pick<Env, 'BILLING_DB'>, accountId: string): Promise<TeamSubscriptionView> {
  const subscription = await currentSubscription(env.BILLING_DB, accountId)
  const status = subscription?.status ?? null
  const open = status !== null && OPEN_STATUSES.has(status)
  const cancelling = open && subscription!.cancel_at_period_end === 1
  return {
    status,
    open,
    cancelling,
    endsAt: cancelling ? (subscription!.cancel_at ?? subscription!.current_period_end) : null,
    periodEnd: subscription?.current_period_end ?? null
  }
}

export type CancelNowOutcome =
  | { ok: true; canceled: true }
  | { ok: false; status: 404 | 409 | 502; error: 'no_subscription' | 'not_cancelling' | 'stripe_unavailable' }

/**
 * Cancels the team's subscription immediately, but only one already set to end: a renewing plan is
 * never canceled from here (409 not_cancelling). Idempotent. On a Stripe failure nothing changes and
 * auth must not delete the team (it would leave a live subscription nobody can reach).
 */
export async function cancelTeamSubscriptionNow(
  env: Env,
  stripe: StripeClient,
  accountId: string,
  now: number
): Promise<CancelNowOutcome> {
  const subscription = await currentSubscription(env.BILLING_DB, accountId)
  if (!subscription) {
    return { ok: false, status: 404, error: 'no_subscription' }
  }
  if (!OPEN_STATUSES.has(subscription.status)) {
    return { ok: true, canceled: true }
  }
  if (subscription.cancel_at_period_end !== 1) {
    return { ok: false, status: 409, error: 'not_cancelling' }
  }
  try {
    await stripe.cancelSubscriptionNow(subscription.stripe_subscription_id)
  } catch (error) {
    // Already canceled in Stripe (a race with its own end): fall through to the re-read.
    if (!(error instanceof StripeError && (error.status === 404 || error.status === 400))) {
      console.error(JSON.stringify({ error: 'cancel_now', status: error instanceof StripeError ? error.status : null }))
      return { ok: false, status: 502, error: 'stripe_unavailable' }
    }
  }
  // Re-read from Stripe (the webhook's path): the mirror goes canceled and the grants are revoked.
  await resyncSubscription(env, stripe, subscription, now)
  const after = await currentSubscription(env.BILLING_DB, accountId)
  return after && OPEN_STATUSES.has(after.status) ? { ok: false, status: 502, error: 'stripe_unavailable' } : { ok: true, canceled: true }
}
