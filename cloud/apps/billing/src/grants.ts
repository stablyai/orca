// Entitlement grants: what each billing account holds, and why. A subscription's grants are a
// projection of its Stripe state (the subscriptions row the webhook writes from a fresh API read);
// a trial's are a projection of its trials row; manual and promo grants are written by ops.
// Projection is idempotent and runs on every Stripe sync, from the cron backfill, and lazily
// whenever a read finds it stale, so grants can't drift from the Stripe mirror.
import { planVersion, trialPlan, type Catalog, type CatalogPlan } from './catalog'
import { isEntitlementKey, parseEntitlementValue, type EntitlementKey } from './entitlement-keys'
import type { SubscriptionRow } from './store'
import type { TrialRow } from './trial'

export const GRANT_SOURCES = ['subscription', 'trial', 'free_policy', 'manual', 'promo'] as const
export type GrantSource = (typeof GRANT_SOURCES)[number]
export type GrantState = 'active' | 'held' | 'revoked'

export type GrantRow = {
  grant_id: string
  subject_id: string
  entitlement_key: string
  value_json: string
  per_seat: number
  seat_quantity: number | null
  source_type: GrantSource
  source_id: string
  plan_id: string | null
  plan_version: number | null
  state: GrantState
  hold_reason: string | null
  held_since: number | null
  starts_at: number
  ends_at: number | null
  revoked_at: number | null
  revoked_reason: string | null
  source_synced_at: number
  created_by: string
  created_at: number
  updated_at: number
}

/** What a source should grant right now; `revoked` drops all its rows. */
type Projection =
  | {
      state: 'active' | 'held'
      holdReason: string | null
      heldSince: number | null
      planId: string
      planVersion: number
      entitlements: Partial<Record<EntitlementKey, { value: unknown; perSeat: boolean }>>
      seatQuantity: number | null
      startsAt: number
      endsAt: number | null
    }
  | { state: 'revoked'; reason: string }

/** Stripe subscription status -> grant state. */
export function subscriptionGrantState(status: string): { state: GrantState; holdReason: string | null; reason?: string } {
  switch (status) {
    case 'active':
    case 'trialing':
      return { state: 'active', holdReason: null }
    case 'past_due':
    case 'unpaid':
      // Stripe is retrying the card: no new starts; running sandboxes stop when the grace ends.
      return { state: 'held', holdReason: 'payment_past_due' }
    case 'paused':
      return { state: 'held', holdReason: 'paused' }
    case 'canceled':
    case 'incomplete_expired':
      return { state: 'revoked', holdReason: null, reason: 'stripe_canceled' }
    case 'incomplete':
      // First payment not done yet: nothing is granted (and nothing existing is kept active).
      return { state: 'revoked', holdReason: null, reason: 'stripe_incomplete' }
    default:
      return { state: 'held', holdReason: 'subscription_inactive' }
  }
}

export async function grantsForSource(db: D1Database, source: GrantSource, sourceId: string): Promise<GrantRow[]> {
  return (
    await db
      .prepare('SELECT * FROM entitlement_grants WHERE source_type = ?1 AND source_id = ?2')
      .bind(source, sourceId)
      .all<GrantRow>()
  ).results
}

export async function grantsForSubject(db: D1Database, subjectId: string): Promise<GrantRow[]> {
  return (
    await db.prepare('SELECT * FROM entitlement_grants WHERE subject_id = ?1').bind(subjectId).all<GrantRow>()
  ).results
}

/** The plan version a subscription maps to: its seat price's, else the one it already has, else current. */
function subscriptionVersion(
  catalog: Catalog,
  plan: CatalogPlan,
  subscription: SubscriptionRow,
  existing: readonly GrantRow[]
): number {
  const price = subscription.seat_price_id
    ? catalog.prices.find((row) => row.stripe_price_id === subscription.seat_price_id && row.plan_id === plan.id)
    : undefined
  if (price?.plan_version && plan.versions.has(price.plan_version)) {
    return price.plan_version
  }
  const kept = existing.find((row) => row.plan_id === plan.id && row.plan_version !== null)?.plan_version
  if (kept && plan.versions.has(kept)) {
    return kept
  }
  return plan.currentVersion
}

export function subscriptionProjection(catalog: Catalog, subscription: SubscriptionRow, existing: readonly GrantRow[]): Projection {
  const mapped = subscriptionGrantState(subscription.status)
  if (mapped.state === 'revoked') {
    return { state: 'revoked', reason: mapped.reason ?? 'stripe_canceled' }
  }
  const plan = catalog.plans.get(subscription.plan)
  if (!plan) {
    // A plan id the catalog doesn't know: keep whatever it had (never silently grant or revoke).
    throw new Error(`plan_not_in_catalog:${subscription.plan}`)
  }
  const version = subscriptionVersion(catalog, plan, subscription, existing)
  return {
    state: mapped.state,
    holdReason: mapped.holdReason,
    heldSince: mapped.state === 'held' ? (subscription.past_due_since ?? subscription.updated_at) : null,
    planId: plan.id,
    planVersion: version,
    entitlements: planVersion(plan, version).entitlements,
    seatQuantity: Math.max(1, subscription.seats),
    startsAt: subscription.current_period_start,
    // Cancel at period end: access lasts until the period ends, then Stripe deletes it.
    endsAt: subscription.cancel_at_period_end === 1 ? subscription.current_period_end : null
  }
}

export function trialProjection(
  catalog: Catalog,
  trial: TrialRow,
  hasSubscription: boolean,
  existing: readonly GrantRow[]
): Projection {
  if (trial.revoked_at !== null) {
    return { state: 'revoked', reason: trial.revoked_reason ?? 'trial_revoked' }
  }
  if (hasSubscription) {
    // Any subscription ends the trial for good.
    return { state: 'revoked', reason: 'superseded_by_plan' }
  }
  const plan = trialPlan(catalog)
  if (!plan) {
    throw new Error('trial_plan_not_in_catalog')
  }
  const kept = existing.find((row) => row.plan_version !== null)?.plan_version
  const version = kept && plan.versions.has(kept) ? kept : plan.currentVersion
  return {
    state: 'active',
    holdReason: null,
    heldSince: null,
    planId: plan.id,
    planVersion: version,
    // The trial's hours were fixed when it was granted (trials.included_seconds); the rest of the
    // terms (concurrency, sizes, no overage) come from the trial plan version.
    entitlements: {
      ...planVersion(plan, version).entitlements,
      sandbox_hours_lifetime: { value: trial.included_seconds / 3600, perSeat: false }
    },
    seatQuantity: null,
    startsAt: trial.granted_at,
    endsAt: null
  }
}

/** Writes a projection for one source: inserts/updates its rows, revokes keys it no longer has. */
export async function applyProjection(
  db: D1Database,
  args: {
    subjectId: string
    source: GrantSource
    sourceId: string
    projection: Projection
    syncedAt: number
    now: number
    actor: string
    existing?: GrantRow[]
  }
): Promise<{ changed: boolean }> {
  const existing = args.existing ?? (await grantsForSource(db, args.source, args.sourceId))
  if (existing.some((row) => row.source_synced_at > args.syncedAt)) {
    // An older read than the one already applied (out-of-order delivery): never let it win.
    return { changed: false }
  }
  const statements: D1PreparedStatement[] = []
  const audit: Array<{ action: string; detail: Record<string, unknown> }> = []
  const projection = args.projection
  if (projection.state === 'revoked') {
    const live = existing.filter((row) => row.state !== 'revoked')
    if (live.length > 0) {
      statements.push(
        db
          .prepare(
            `UPDATE entitlement_grants SET state = 'revoked', revoked_at = ?3, revoked_reason = ?4, hold_reason = NULL,
               source_synced_at = ?5, updated_at = ?3
             WHERE source_type = ?1 AND source_id = ?2 AND state <> 'revoked'`
          )
          .bind(args.source, args.sourceId, args.now, projection.reason, args.syncedAt)
      )
      audit.push({ action: 'revoke', detail: { reason: projection.reason, keys: live.map((row) => row.entitlement_key) } })
    }
  } else {
    const byKey = new Map(existing.map((row) => [row.entitlement_key, row]))
    const wanted = new Set<string>()
    for (const [key, entry] of Object.entries(projection.entitlements)) {
      if (!entry || !isEntitlementKey(key)) {
        continue
      }
      wanted.add(key)
      const value = JSON.stringify(entry.value)
      const perSeat = entry.perSeat ? 1 : 0
      const seats = entry.perSeat ? projection.seatQuantity : null
      const row = byKey.get(key)
      if (row?.state === 'revoked' && row.revoked_reason !== 'plan_changed' && args.source !== 'manual' && args.source !== 'promo') {
        // Revocation is terminal for a Stripe subscription or a trial: a canceled subscription
        // can't come back (Stripe makes a new one), and a stale read must not revive it.
        continue
      }
      const same =
        row !== undefined &&
        row.value_json === value &&
        row.per_seat === perSeat &&
        row.seat_quantity === seats &&
        row.state === projection.state &&
        row.hold_reason === projection.holdReason &&
        row.plan_id === projection.planId &&
        row.plan_version === projection.planVersion &&
        row.ends_at === projection.endsAt &&
        row.starts_at === projection.startsAt
      if (same) {
        continue
      }
      statements.push(
        db
          .prepare(
            `INSERT INTO entitlement_grants (grant_id, subject_id, entitlement_key, value_json, per_seat, seat_quantity,
               source_type, source_id, plan_id, plan_version, state, hold_reason, held_since, starts_at, ends_at,
               source_synced_at, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)
             ON CONFLICT (source_type, source_id, entitlement_key) DO UPDATE SET
               subject_id = excluded.subject_id, value_json = excluded.value_json, per_seat = excluded.per_seat,
               seat_quantity = excluded.seat_quantity, plan_id = excluded.plan_id, plan_version = excluded.plan_version,
               state = excluded.state, hold_reason = excluded.hold_reason,
               held_since = CASE WHEN excluded.state = 'held' THEN COALESCE(entitlement_grants.held_since, excluded.held_since) ELSE NULL END,
               starts_at = excluded.starts_at, ends_at = excluded.ends_at, revoked_at = NULL, revoked_reason = NULL,
               source_synced_at = excluded.source_synced_at, updated_at = excluded.updated_at
             WHERE entitlement_grants.source_synced_at <= excluded.source_synced_at`
          )
          .bind(
            `g_${crypto.randomUUID()}`,
            args.subjectId,
            key,
            value,
            perSeat,
            seats,
            args.source,
            args.sourceId,
            projection.planId,
            projection.planVersion,
            projection.state,
            projection.holdReason,
            projection.heldSince,
            projection.startsAt,
            projection.endsAt,
            args.syncedAt,
            args.actor,
            args.now
          )
      )
      audit.push({
        action: !row ? 'grant' : row.state !== projection.state ? (projection.state === 'held' ? 'hold' : 'release') : 'adjust',
        detail: { key, value: entry.value, perSeat: entry.perSeat, seats, state: projection.state, holdReason: projection.holdReason, plan: `${projection.planId}@${projection.planVersion}`, endsAt: projection.endsAt }
      })
    }
    const dropped = existing.filter((row) => !wanted.has(row.entitlement_key) && row.state !== 'revoked')
    for (const row of dropped) {
      statements.push(
        db
          .prepare(
            `UPDATE entitlement_grants SET state = 'revoked', revoked_at = ?2, revoked_reason = 'plan_changed', source_synced_at = ?3, updated_at = ?2
             WHERE grant_id = ?1`
          )
          .bind(row.grant_id, args.now, args.syncedAt)
      )
      audit.push({ action: 'revoke', detail: { key: row.entitlement_key, reason: 'plan_changed' } })
    }
  }
  if (statements.length === 0) {
    if (existing.some((row) => row.source_synced_at < args.syncedAt)) {
      // Nothing changed, but the source was read again: record it, so the row isn't seen as stale.
      await db
        .prepare('UPDATE entitlement_grants SET source_synced_at = ?3 WHERE source_type = ?1 AND source_id = ?2 AND source_synced_at < ?3')
        .bind(args.source, args.sourceId, args.syncedAt)
        .run()
    }
    return { changed: false }
  }
  for (const entry of audit) {
    statements.push(
      db
        .prepare(
          'INSERT INTO entitlement_audit (subject_id, source_type, source_id, action, detail_json, actor, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
        )
        .bind(args.subjectId, args.source, args.sourceId, entry.action, JSON.stringify(entry.detail), args.actor, args.now)
    )
  }
  await db.batch(statements)
  return { changed: true }
}

/** Brings one subscription's grants in line with its Stripe mirror row. */
export async function projectSubscription(
  db: D1Database,
  catalog: Catalog,
  subscription: SubscriptionRow,
  now: number,
  actor: string
): Promise<{ changed: boolean }> {
  const existing = await grantsForSource(db, 'subscription', subscription.stripe_subscription_id)
  return applyProjection(db, {
    subjectId: subscription.account_id,
    source: 'subscription',
    sourceId: subscription.stripe_subscription_id,
    projection: subscriptionProjection(catalog, subscription, existing),
    syncedAt: subscription.updated_at,
    now,
    actor,
    existing
  })
}

export async function projectTrial(
  db: D1Database,
  catalog: Catalog,
  trial: TrialRow,
  hasSubscription: boolean,
  now: number,
  actor: string
): Promise<{ changed: boolean }> {
  const existing = await grantsForSource(db, 'trial', trial.account_id)
  const projection = trialProjection(catalog, trial, hasSubscription, existing)
  // A trial row has no update time; its projection only ever moves forward (granted -> revoked),
  // so the time it was first projected is a fine "synced at".
  const syncedAt = existing[0]?.source_synced_at ?? trial.granted_at
  return applyProjection(db, { subjectId: trial.account_id, source: 'trial', sourceId: trial.account_id, projection, syncedAt, now, actor, existing })
}

/** Ops: grant (or replace) a manual/promo entitlement. Validated against the registry. */
export async function putManualGrant(
  db: D1Database,
  args: {
    subjectId: string
    source: 'manual' | 'promo'
    sourceId: string
    entitlements: Record<string, { value: unknown; perSeat?: boolean }>
    startsAt: number
    endsAt: number | null
    actor: string
    now: number
  }
): Promise<{ changed: boolean }> {
  const entitlements: Partial<Record<EntitlementKey, { value: unknown; perSeat: boolean }>> = {}
  for (const [key, entry] of Object.entries(args.entitlements)) {
    entitlements[key as EntitlementKey] = parseEntitlementValue(key, entry)
  }
  return applyProjection(db, {
    subjectId: args.subjectId,
    source: args.source,
    sourceId: args.sourceId,
    projection: {
      state: 'active',
      holdReason: null,
      heldSince: null,
      planId: 'manual',
      planVersion: 0,
      entitlements,
      seatQuantity: null,
      startsAt: args.startsAt,
      endsAt: args.endsAt
    },
    syncedAt: args.now,
    now: args.now,
    actor: args.actor
  })
}

export async function revokeManualGrant(
  db: D1Database,
  args: { subjectId: string; source: 'manual' | 'promo'; sourceId: string; reason: string; actor: string; now: number }
): Promise<{ changed: boolean }> {
  return applyProjection(db, {
    subjectId: args.subjectId,
    source: args.source,
    sourceId: args.sourceId,
    projection: { state: 'revoked', reason: args.reason },
    syncedAt: args.now,
    now: args.now,
    actor: args.actor
  })
}

/** Grants that count at `now`: not revoked and inside their start/end. */
export function liveAt(row: GrantRow, now: number): boolean {
  return row.state !== 'revoked' && row.starts_at <= now && (row.ends_at === null || now < row.ends_at)
}
