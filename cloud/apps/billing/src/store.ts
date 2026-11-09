// D1 access. Every multi-statement write goes through db.batch() (one transaction), and every
// insert that can be retried is INSERT OR IGNORE on a caller-supplied key.
import type { PlanId } from './plans'

export type SubscriptionRow = {
  stripe_subscription_id: string
  account_id: string
  stripe_customer_id: string
  status: string
  plan: PlanId
  seats: number
  overage_enabled: number
  current_period_start: number
  current_period_end: number
  cancel_at_period_end: number
  updated_at: number
}

export type MeterReportRow = {
  usage_id: string
  stripe_customer_id: string
  seconds: number
  event_timestamp: number
  attempts: number
}

export async function ensureAccount(db: D1Database, accountId: string, now: number): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO billing_accounts (account_id, created_at, updated_at) VALUES (?1, ?2, ?2)')
    .bind(accountId, now)
    .run()
}

export async function customerFor(db: D1Database, accountId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT stripe_customer_id FROM billing_accounts WHERE account_id = ?1')
    .bind(accountId)
    .first<{ stripe_customer_id: string | null }>()
  return row?.stripe_customer_id ?? null
}

export async function accountForCustomer(db: D1Database, customerId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT account_id FROM billing_accounts WHERE stripe_customer_id = ?1')
    .bind(customerId)
    .first<{ account_id: string }>()
  return row?.account_id ?? null
}

/** Links only an unlinked account, so a race between two first checkouts keeps the first. */
export async function linkCustomer(db: D1Database, accountId: string, customerId: string, now: number): Promise<string> {
  await db
    .prepare(
      'UPDATE billing_accounts SET stripe_customer_id = ?2, updated_at = ?3 WHERE account_id = ?1 AND stripe_customer_id IS NULL'
    )
    .bind(accountId, customerId, now)
    .run()
  return (await customerFor(db, accountId)) ?? customerId
}

// Live statuses sort first, then the latest period: the row entitlements are computed from.
export async function currentSubscription(db: D1Database, accountId: string): Promise<SubscriptionRow | null> {
  return db
    .prepare(
      `SELECT * FROM subscriptions WHERE account_id = ?1
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'trialing' THEN 0 WHEN 'past_due' THEN 1 ELSE 2 END,
                current_period_end DESC
       LIMIT 1`
    )
    .bind(accountId)
    .first<SubscriptionRow>()
}

export async function upsertSubscription(db: D1Database, row: SubscriptionRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO subscriptions (stripe_subscription_id, account_id, stripe_customer_id, status, plan, seats,
         overage_enabled, current_period_start, current_period_end, cancel_at_period_end, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT (stripe_subscription_id) DO UPDATE SET
         status = excluded.status, plan = excluded.plan, seats = excluded.seats,
         overage_enabled = excluded.overage_enabled, current_period_start = excluded.current_period_start,
         current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
         updated_at = excluded.updated_at`
    )
    .bind(
      row.stripe_subscription_id,
      row.account_id,
      row.stripe_customer_id,
      row.status,
      row.plan,
      row.seats,
      row.overage_enabled,
      row.current_period_start,
      row.current_period_end,
      row.cancel_at_period_end,
      row.updated_at
    )
    .run()
}

export async function periodUsage(
  db: D1Database,
  accountId: string,
  periodStart: number
): Promise<{ usedSeconds: number; overageSeconds: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(weighted_seconds), 0) AS used, COALESCE(SUM(overage_seconds), 0) AS overage
       FROM usage_events WHERE account_id = ?1 AND period_start = ?2`
    )
    .bind(accountId, periodStart)
    .first<{ used: number; overage: number }>()
  return { usedSeconds: row?.used ?? 0, overageSeconds: row?.overage ?? 0 }
}

export type UsageInsert = {
  usageId: string
  accountId: string
  sandboxId: string
  machineSize: string
  startedAt: number
  endedAt: number
  weightedSeconds: number
  periodStart: number | null
  includedSeconds: number
  now: number
  // Set when overage is billable: queues a meter report in the same transaction.
  meterCustomer: string | null
}

/**
 * Records one usage segment and, atomically, the overage it adds. The overage is computed inside
 * the INSERT from the period's running total, so concurrent reports cannot both claim the same
 * included seconds. Returns false when usageId was already recorded (a retry).
 */
export async function insertUsage(db: D1Database, usage: UsageInsert): Promise<boolean> {
  const insert = db
    .prepare(
      `INSERT OR IGNORE INTO usage_events (usage_id, account_id, sandbox_id, machine_size, started_at, ended_at,
         weighted_seconds, period_start, overage_seconds, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
         CASE WHEN ?8 IS NULL THEN 0
              ELSE MAX(0, MIN(?7, COALESCE(SUM(weighted_seconds), 0) + ?7 - ?9)) END,
         ?10
       FROM usage_events WHERE account_id = ?2 AND period_start IS ?8`
    )
    .bind(
      usage.usageId,
      usage.accountId,
      usage.sandboxId,
      usage.machineSize,
      usage.startedAt,
      usage.endedAt,
      usage.weightedSeconds,
      usage.periodStart,
      usage.includedSeconds,
      usage.now
    )
  const statements = [insert]
  if (usage.meterCustomer) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO meter_reports (usage_id, stripe_customer_id, seconds, event_timestamp, status, created_at)
           SELECT usage_id, ?2, overage_seconds, ended_at, 'pending', ?3
           FROM usage_events WHERE usage_id = ?1 AND overage_seconds > 0`
        )
        .bind(usage.usageId, usage.meterCustomer, usage.now)
    )
  }
  const [result] = await db.batch(statements)
  return (result?.meta.changes ?? 0) > 0
}

export async function usageOverage(db: D1Database, usageId: string): Promise<number> {
  const row = await db
    .prepare('SELECT overage_seconds FROM usage_events WHERE usage_id = ?1')
    .bind(usageId)
    .first<{ overage_seconds: number }>()
  return row?.overage_seconds ?? 0
}

export async function pendingMeterReports(db: D1Database, limit: number, usageId?: string): Promise<MeterReportRow[]> {
  const query = usageId
    ? db
        .prepare(
          "SELECT usage_id, stripe_customer_id, seconds, event_timestamp, attempts FROM meter_reports WHERE usage_id = ?1 AND status = 'pending'"
        )
        .bind(usageId)
    : db
        .prepare(
          "SELECT usage_id, stripe_customer_id, seconds, event_timestamp, attempts FROM meter_reports WHERE status = 'pending' ORDER BY created_at LIMIT ?1"
        )
        .bind(limit)
  return (await query.all<MeterReportRow>()).results
}

export async function markMeterReport(
  db: D1Database,
  usageId: string,
  outcome: { sent: true; now: number } | { sent: false; error: string; giveUp: boolean }
): Promise<void> {
  if (outcome.sent) {
    await db
      .prepare("UPDATE meter_reports SET status = 'sent', sent_at = ?2, attempts = attempts + 1 WHERE usage_id = ?1")
      .bind(usageId, outcome.now)
      .run()
    return
  }
  await db
    .prepare('UPDATE meter_reports SET status = ?2, last_error = ?3, attempts = attempts + 1 WHERE usage_id = ?1')
    .bind(usageId, outcome.giveUp ? 'failed' : 'pending', outcome.error.slice(0, 200))
    .run()
}

/** Claims an event id. Returns 'duplicate' when it was already processed successfully. */
export async function claimEvent(db: D1Database, eventId: string, type: string, now: number): Promise<'new' | 'duplicate'> {
  await db
    .prepare('INSERT OR IGNORE INTO stripe_events (event_id, type, received_at) VALUES (?1, ?2, ?3)')
    .bind(eventId, type, now)
    .run()
  const row = await db
    .prepare('SELECT processed_at FROM stripe_events WHERE event_id = ?1')
    .bind(eventId)
    .first<{ processed_at: number | null }>()
  return row?.processed_at ? 'duplicate' : 'new'
}

/** `now` marks the event done (with an optional note, e.g. why it was ignored); `error` leaves it retryable. */
export async function finishEvent(
  db: D1Database,
  eventId: string,
  outcome: { now: number; note?: string } | { error: string }
): Promise<void> {
  if ('now' in outcome) {
    await db
      .prepare('UPDATE stripe_events SET processed_at = ?2, last_error = ?3 WHERE event_id = ?1')
      .bind(eventId, outcome.now, outcome.note ?? null)
      .run()
    return
  }
  await db
    .prepare('UPDATE stripe_events SET last_error = ?2 WHERE event_id = ?1')
    .bind(eventId, outcome.error.slice(0, 200))
    .run()
}
