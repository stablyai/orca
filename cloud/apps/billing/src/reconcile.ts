// Reconciliation (cron): a missed or failed webhook can't leave stale access behind.
// 1. Replays Stripe's event log (GET /v1/events, kept 30 days) from a cursor: every event billing
//    acts on that isn't already processed goes through the webhook's own path.
// 2. Re-reads a rolling slice of the subscriptions we hold that still matter (open in Stripe, or
//    holding live grants), oldest first, so even an event Stripe never sent heals within hours.
// 3. Refreshes the catalog's Stripe prices.
// Off while ENTITLEMENTS_MODE is off (the legacy service had no reconciliation).
import { syncCatalogPrices } from './catalog-sync'
import type { Env } from './env'
import { entitlementsMode } from './entitlements-mode'
import { StripeError, type StripeClient } from './stripe'
import type { SubscriptionRow } from './store'
import { HANDLED_EVENT_TYPES, processStripeEvent, resyncSubscription, type StripeEvent } from './webhook'

const CURSOR_KEY = 'events_cursor'
/** A subscription is re-read at most this often by the rolling sweep. */
export const RESYNC_AFTER_MS = 6 * 3600 * 1000

async function readCursor(db: D1Database): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM stripe_sync_state WHERE key = ?1').bind(CURSOR_KEY).first<{ value: string }>()
  return row?.value ?? null
}

async function writeCursor(db: D1Database, value: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO stripe_sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(CURSOR_KEY, value, now)
    .run()
}

/**
 * Applies events newer than the cursor, oldest first, a page at a time. The first run only sets
 * the cursor to the newest event (history before that was delivered by webhooks, and step 2
 * covers anything that wasn't). A failed event stops the replay there, to be retried next run.
 */
export async function replayStripeEvents(
  env: Env,
  stripe: StripeClient,
  now: number,
  options: { pages?: number; pageSize?: number } = {}
): Promise<{ replayed: number; applied: number; failed: number; error?: string }> {
  const db = env.BILLING_DB
  const pageSize = options.pageSize ?? 100
  let cursor = await readCursor(db)
  let replayed = 0
  let applied = 0
  try {
    if (!cursor) {
      const newest = await stripe.listEvents({ types: HANDLED_EVENT_TYPES, limit: 1 })
      if (newest.data[0]) {
        await writeCursor(db, newest.data[0].id, now)
      }
      return { replayed: 0, applied: 0, failed: 0 }
    }
    for (let page = 0; page < (options.pages ?? 5); page++) {
      const result = await stripe.listEvents({ types: HANDLED_EVENT_TYPES, endingBefore: cursor, limit: pageSize })
      // Stripe lists newest first; apply oldest first.
      const events = [...result.data].reverse()
      for (const event of events) {
        replayed++
        const outcome = await processStripeEvent(env, stripe, event as StripeEvent, now)
        if (outcome.status >= 500) {
          return { replayed, applied, failed: 1 }
        }
        if (outcome.body.received === true) {
          applied++
          console.log(JSON.stringify({ event: 'reconcile_fixed', source: 'event_replay', stripeEvent: event.id, type: event.type }))
        }
        cursor = event.id
        await writeCursor(db, cursor, now)
      }
      if (!result.has_more || events.length === 0) {
        break
      }
    }
    return { replayed, applied, failed: 0 }
  } catch (error) {
    // A restricted key without Events read answers 403: the rolling re-sync still runs.
    const message = error instanceof StripeError ? `stripe_${error.status}` : error instanceof Error ? error.message.slice(0, 120) : 'unknown'
    console.error(JSON.stringify({ error: 'reconcile_events', message }))
    return { replayed, applied, failed: 0, error: message }
  }
}

/** Re-reads the subscriptions that still matter and haven't been read for RESYNC_AFTER_MS. */
export async function resyncStaleSubscriptions(
  env: Env,
  stripe: StripeClient,
  now: number,
  limit = 25
): Promise<{ checked: number; changed: number; canceledMissing: number; failed: number }> {
  const db = env.BILLING_DB
  const rows = (
    await db
      .prepare(
        `SELECT s.* FROM subscriptions s
         WHERE s.updated_at < ?1
           AND (s.status NOT IN ('canceled', 'incomplete_expired')
                OR EXISTS (SELECT 1 FROM entitlement_grants g WHERE g.source_type = 'subscription'
                             AND g.source_id = s.stripe_subscription_id AND g.state <> 'revoked'))
         ORDER BY s.updated_at LIMIT ?2`
      )
      .bind(now - RESYNC_AFTER_MS, limit)
      .all<SubscriptionRow>()
  ).results
  let changed = 0
  let canceledMissing = 0
  let failed = 0
  for (const row of rows) {
    try {
      const outcome = await resyncSubscription(env, stripe, row, now)
      const after = await db
        .prepare('SELECT status, seats, cancel_at_period_end, current_period_end FROM subscriptions WHERE stripe_subscription_id = ?1')
        .bind(row.stripe_subscription_id)
        .first<Pick<SubscriptionRow, 'status' | 'seats' | 'cancel_at_period_end' | 'current_period_end'>>()
      if (outcome === 'canceled_missing') {
        canceledMissing++
      }
      if (
        after &&
        (after.status !== row.status || after.seats !== row.seats || after.cancel_at_period_end !== row.cancel_at_period_end || after.current_period_end !== row.current_period_end)
      ) {
        changed++
        console.log(JSON.stringify({ event: 'reconcile_fixed', source: 'resync', subscription: row.stripe_subscription_id, from: row.status, to: after.status }))
      }
    } catch (error) {
      failed++
      console.error(JSON.stringify({ error: 'reconcile_resync', subscription: row.stripe_subscription_id, message: error instanceof Error ? error.message.slice(0, 160) : '' }))
    }
  }
  return { checked: rows.length, changed, canceledMissing, failed }
}

export async function reconcile(env: Env, stripe: StripeClient, now: number) {
  if (entitlementsMode(env) === 'off') {
    return null
  }
  const prices = await syncCatalogPrices(env, stripe, now)
  const events = await replayStripeEvents(env, stripe, now)
  const subscriptions = await resyncStaleSubscriptions(env, stripe, now)
  const summary = { event: 'billing_reconcile', prices, events, subscriptions }
  if (events.applied + subscriptions.changed + subscriptions.failed + events.failed > 0 || prices.error || events.error) {
    console.log(JSON.stringify(summary))
  }
  return summary
}
