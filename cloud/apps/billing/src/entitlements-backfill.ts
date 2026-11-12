// Cron backfill/heal for entitlement grants (ENTITLEMENTS_MODE shadow|on): projects every
// subscription and trial whose grants are missing or older than its row. Idempotent and bounded
// per run, so the first runs after 0008 backfill existing accounts and later runs heal any write
// path that skipped projection. The lazy read path (entitlements.ts) does the same per account.
import { loadCatalog } from './catalog'
import type { Env } from './env'
import { entitlementsMode } from './entitlements-mode'
import { projectSubscription, projectTrial } from './grants'
import type { SubscriptionRow } from './store'
import type { TrialRow } from './trial'

export async function backfillGrants(
  env: Pick<Env, 'BILLING_DB' | 'ENTITLEMENTS_MODE'>,
  now: number,
  limit = 200
): Promise<{ subscriptions: number; trials: number; failed: number }> {
  if (entitlementsMode(env) === 'off') {
    return { subscriptions: 0, trials: 0, failed: 0 }
  }
  const db = env.BILLING_DB
  const catalog = await loadCatalog(db, now)
  const subscriptions = (
    await db
      .prepare(
        `SELECT s.* FROM subscriptions s
         WHERE NOT EXISTS (SELECT 1 FROM entitlement_grants g WHERE g.source_type = 'subscription'
                             AND g.source_id = s.stripe_subscription_id AND g.source_synced_at >= s.updated_at)
           AND (s.status NOT IN ('canceled', 'incomplete_expired', 'incomplete')
                OR EXISTS (SELECT 1 FROM entitlement_grants g WHERE g.source_type = 'subscription'
                             AND g.source_id = s.stripe_subscription_id AND g.state <> 'revoked'))
         ORDER BY s.updated_at LIMIT ?1`
      )
      .bind(limit)
      .all<SubscriptionRow>()
  ).results
  const trials = (
    await db
      .prepare(
        `SELECT t.*, EXISTS (SELECT 1 FROM subscriptions s WHERE s.account_id = t.account_id) AS has_subscription FROM trials t
         WHERE (t.revoked_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.account_id = t.account_id)
                AND NOT EXISTS (SELECT 1 FROM entitlement_grants g WHERE g.source_type = 'trial' AND g.source_id = t.account_id))
            OR ((t.revoked_at IS NOT NULL OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.account_id = t.account_id))
                AND EXISTS (SELECT 1 FROM entitlement_grants g WHERE g.source_type = 'trial' AND g.source_id = t.account_id AND g.state <> 'revoked'))
         ORDER BY t.granted_at LIMIT ?1`
      )
      .bind(limit)
      .all<TrialRow & { has_subscription: number }>()
  ).results
  let failed = 0
  for (const subscription of subscriptions) {
    try {
      await projectSubscription(db, catalog, subscription, now, 'backfill')
    } catch (error) {
      failed++
      console.error(JSON.stringify({ error: 'grant_backfill', subscription: subscription.stripe_subscription_id, message: error instanceof Error ? error.message.slice(0, 200) : '' }))
    }
  }
  for (const trial of trials) {
    try {
      await projectTrial(db, catalog, trial, trial.has_subscription === 1, now, 'backfill')
    } catch (error) {
      failed++
      console.error(JSON.stringify({ error: 'grant_backfill', trial: trial.account_id, message: error instanceof Error ? error.message.slice(0, 200) : '' }))
    }
  }
  return { subscriptions: subscriptions.length, trials: trials.length, failed }
}
