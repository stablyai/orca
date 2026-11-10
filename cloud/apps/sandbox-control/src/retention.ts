// Hourly cron housekeeping: provider-vs-D1 orphan sweep, data deletion after cancel/unpaid, and idle
// retention for long-suspended sandboxes. Every destructive step is two-phase (seen, then acted on
// after a grace period) and logged; partial provider listings never delete anything.
import { RETENTION_HOLD_REASONS } from './entitlements'
import { destroySandbox, goldenSnapshotIds, suspendSandbox, type LifecycleDeps } from './lifecycle'
import { getControlState, setControlState } from './guardrails'
import { ACTIVE_STATUSES, getSandboxByProviderName, listByStatus, type SandboxRow } from './store'

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

export type RetentionConfig = {
  /** Data kept this long after an account goes canceled/unpaid, then destroyed. */
  dataRetentionMs: number
  /** Suspended sandboxes untouched this long are destroyed (active subscriptions too). */
  idleRetentionMs: number
  /** Warning hook fires this long before either deletion. */
  warningLeadMs: number
  /** Orphans are suspended on first sight and deleted once seen for this long. */
  orphanGraceMs: number
  /** Housekeeping cadence inside the 5-minute cron. */
  sweepIntervalMs: number
  /** Re-ask billing about an account's standing at most this often. */
  holdProbeIntervalMs: number
}

export const DEFAULT_RETENTION: RetentionConfig = {
  dataRetentionMs: 30 * DAY_MS,
  idleRetentionMs: 90 * DAY_MS,
  warningLeadMs: 7 * DAY_MS,
  orphanGraceMs: 24 * HOUR_MS,
  sweepIntervalMs: HOUR_MS,
  holdProbeIntervalMs: DAY_MS
}

export type RetentionWarning = {
  kind: 'data_deletion' | 'idle_deletion'
  accountId: string
  sandboxIds: string[]
  deleteAt: number
  reason: string
}

/** Email hook. Stubbed: logs a structured event the alerting Worker / mailer can pick up. */
export type RetentionNotifier = { warn(warning: RetentionWarning): Promise<void> }
export const LOG_NOTIFIER: RetentionNotifier = {
  async warn(warning) {
    console.log(JSON.stringify({ event: 'retention_warning', ...warning }))
  }
}

export type HousekeepingSummary = {
  swept: boolean
  orphanSandboxesSuspended: number
  orphanSandboxesDeleted: number
  orphanSnapshotsSeen: number
  orphanSnapshotsDeleted: number
  rowsMissingProvider: number
  holdsOpened: number
  holdsCleared: number
  retentionWarnings: number
  retentionDestroyed: number
  idleWarnings: number
  idleDestroyed: number
}

function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...fields }))
}

function retention(deps: LifecycleDeps): RetentionConfig {
  return deps.retention ?? DEFAULT_RETENTION
}

// ---- account holds (canceled / unpaid) ----

type HoldRow = { account_id: string; reason: string; since: number; checked_at: number; warned_at: number | null; purged_at: number | null }

/** Records that billing says this account is canceled/unpaid; the retention clock starts at first sight. */
export async function openHold(db: D1Database, accountId: string, reason: string, now: number): Promise<boolean> {
  const existing = await db.prepare('SELECT * FROM account_holds WHERE account_id = ?').bind(accountId).first<HoldRow>()
  if (existing && existing.reason !== 'active') {
    await db.prepare('UPDATE account_holds SET checked_at = ? WHERE account_id = ?').bind(now, accountId).run()
    return false
  }
  await db
    .prepare(
      `INSERT INTO account_holds (account_id, reason, since, checked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET reason = excluded.reason, since = excluded.since,
         checked_at = excluded.checked_at, warned_at = NULL, purged_at = NULL`
    )
    .bind(accountId, reason, now, now)
    .run()
  log('retention_hold_opened', { accountId, reason })
  return true
}

/** Billing allows starts again (resubscribed / paid): the hold and its clock are dropped. */
async function clearHold(db: D1Database, accountId: string, now: number): Promise<boolean> {
  const existing = await db.prepare('SELECT * FROM account_holds WHERE account_id = ?').bind(accountId).first<HoldRow>()
  await db
    .prepare(
      `INSERT INTO account_holds (account_id, reason, since, checked_at) VALUES (?, 'active', ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET reason = 'active', since = excluded.since, checked_at = excluded.checked_at,
         warned_at = NULL, purged_at = NULL`
    )
    .bind(accountId, now, now)
    .run()
  return existing !== null && existing.reason !== 'active'
}

/** Accounts with stored sandboxes whose standing has not been checked recently. */
async function accountsToProbe(db: D1Database, before: number): Promise<{ account_id: string; machine_size: SandboxRow['machine_size'] }[]> {
  const { results } = await db
    .prepare(
      `SELECT s.account_id, MIN(s.machine_size) AS machine_size FROM sandboxes s
       LEFT JOIN account_holds h ON h.account_id = s.account_id
       WHERE s.status <> 'destroyed' AND (h.checked_at IS NULL OR h.checked_at < ?)
       GROUP BY s.account_id LIMIT 50`
    )
    .bind(before)
    .all<{ account_id: string; machine_size: SandboxRow['machine_size'] }>()
  return results
}

async function probeHolds(deps: LifecycleDeps, summary: HousekeepingSummary): Promise<void> {
  const now = deps.now()
  for (const account of await accountsToProbe(deps.db, now - retention(deps).holdProbeIntervalMs)) {
    try {
      // runningSandboxes 0: we ask about the account's standing, not concurrency.
      const decision = await deps.entitlements.checkStart({ accountId: account.account_id, machineSize: account.machine_size, runningSandboxes: 0 })
      if (!decision.allow && RETENTION_HOLD_REASONS.has(decision.reason ?? '')) {
        summary.holdsOpened += (await openHold(deps.db, account.account_id, decision.reason!, now)) ? 1 : 0
      } else if (decision.allow) {
        summary.holdsCleared += (await clearHold(deps.db, account.account_id, now)) ? 1 : 0
      } else {
        // Other denials (hours exhausted, cap): not a cancellation; just remember we looked.
        await deps.db.prepare('UPDATE account_holds SET checked_at = ? WHERE account_id = ?').bind(now, account.account_id).run()
      }
    } catch {
      // Billing unavailable: never start a deletion clock on an outage.
    }
  }
}

async function enforceHolds(deps: LifecycleDeps, notifier: RetentionNotifier, summary: HousekeepingSummary) {
  const config = retention(deps)
  const now = deps.now()
  const { results } = await deps.db
    .prepare(`SELECT * FROM account_holds WHERE reason <> 'active' AND purged_at IS NULL AND since <= ? LIMIT 100`)
    .bind(now - (config.dataRetentionMs - config.warningLeadMs))
    .all<HoldRow>()
  for (const hold of results) {
    const deleteAt = hold.since + config.dataRetentionMs
    const rows = await liveRows(deps.db, hold.account_id)
    if (hold.warned_at === null) {
      await notifier.warn({ kind: 'data_deletion', accountId: hold.account_id, sandboxIds: rows.map((r) => r.id), deleteAt, reason: hold.reason })
      await deps.db.prepare('UPDATE account_holds SET warned_at = ? WHERE account_id = ?').bind(now, hold.account_id).run()
      summary.retentionWarnings++
      continue
    }
    // Deletion waits for both the deadline and a full warning lead after the warning went out.
    if (now < deleteAt || now < hold.warned_at + config.warningLeadMs) {
      continue
    }
    let remaining = 0
    for (const row of rows) {
      try {
        await destroySandbox(deps, row)
        summary.retentionDestroyed++
      } catch {
        remaining++
      }
    }
    if (remaining === 0) {
      await deps.db.prepare('UPDATE account_holds SET purged_at = ? WHERE account_id = ?').bind(now, hold.account_id).run()
    }
    log('retention_purge', { accountId: hold.account_id, destroyed: rows.length - remaining, remaining, reason: hold.reason })
  }
}

async function liveRows(db: D1Database, accountId: string): Promise<SandboxRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM sandboxes WHERE account_id = ? AND status <> 'destroyed'`)
    .bind(accountId)
    .all<SandboxRow>()
  return results
}

// ---- idle retention ----

async function enforceIdle(deps: LifecycleDeps, notifier: RetentionNotifier, summary: HousekeepingSummary) {
  const config = retention(deps)
  const now = deps.now()
  const { results } = await deps.db
    .prepare(`SELECT * FROM sandboxes WHERE status = 'suspended' AND updated_at <= ? ORDER BY updated_at LIMIT 100`)
    .bind(now - (config.idleRetentionMs - config.warningLeadMs))
    .all<SandboxRow>()
  for (const row of results) {
    if (row.retention_warned_at === null) {
      await notifier.warn({
        kind: 'idle_deletion',
        accountId: row.account_id,
        sandboxIds: [row.id],
        deleteAt: Math.max(row.updated_at + config.idleRetentionMs, now + config.warningLeadMs),
        reason: 'idle'
      })
      // Not a transition: the idle clock (updated_at) must not move.
      await deps.db.prepare('UPDATE sandboxes SET retention_warned_at = ? WHERE id = ? AND generation = ?').bind(now, row.id, row.generation).run()
      summary.idleWarnings++
    } else if (now >= row.updated_at + config.idleRetentionMs && now >= row.retention_warned_at + config.warningLeadMs) {
      try {
        await destroySandbox(deps, row)
        summary.idleDestroyed++
        log('idle_retention_destroy', { sandboxId: row.id, accountId: row.account_id, idleDays: Math.floor((now - row.updated_at) / DAY_MS) })
      } catch {
        // Retried next sweep.
      }
    }
  }
}

// ---- orphan sweep ----

async function upsertOrphan(db: D1Database, kind: 'sandbox' | 'snapshot', id: string, now: number) {
  await db
    .prepare(
      `INSERT INTO provider_orphans (kind, provider_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (kind, provider_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
    )
    .bind(kind, id, now, now)
    .run()
  return (await db
    .prepare('SELECT * FROM provider_orphans WHERE kind = ? AND provider_id = ?')
    .bind(kind, id)
    .first<{ first_seen_at: number; suspended_at: number | null; deleted_at: number | null }>())!
}

async function clearOrphan(db: D1Database, kind: string, id: string) {
  await db.prepare('DELETE FROM provider_orphans WHERE kind = ? AND provider_id = ? AND deleted_at IS NULL').bind(kind, id).run()
}

async function isPooledVm(db: D1Database, providerName: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 AS hit FROM sandbox_pool WHERE provider_name = ?').bind(providerName).first<{ hit: number }>()) !== null
}

async function sweepOrphans(deps: LifecycleDeps, summary: HousekeepingSummary): Promise<void> {
  const now = deps.now()
  const grace = retention(deps).orphanGraceMs
  const env = deps.config.environment
  const listing = await deps.provider.listSandboxes()
  const providerNames = new Set(listing.sandboxes.map((s) => s.name))
  for (const box of listing.sandboxes) {
    // Only this environment's sandboxes; golden-image build boxes and other envs are not ours to judge.
    if (box.tags.orcaEnv !== env || !box.tags.orcaSandbox) {
      continue
    }
    // A warm-pool VM has no sandboxes row until it is claimed; its record is the pool row.
    if (box.tags.orcaPool && (await isPooledVm(deps.db, box.name))) {
      await clearOrphan(deps.db, 'sandbox', box.name)
      continue
    }
    const row = await getSandboxByProviderName(deps.db, box.name)
    if (row && row.status !== 'destroyed') {
      await clearOrphan(deps.db, 'sandbox', box.name)
      continue
    }
    const orphan = await upsertOrphan(deps.db, 'sandbox', box.name, now)
    if (orphan.deleted_at !== null) {
      continue
    }
    if (now - orphan.first_seen_at >= grace) {
      await deps.provider.deleteSandbox(box.name)
      for (const snapshot of await deps.provider.listSnapshots(box.name)) {
        if (snapshot.status === 'created' && !goldenSnapshotIds(deps.config).includes(snapshot.id) && !(await isEnvironmentBuildSnapshot(deps.db, snapshot.id))) {
          await deps.provider.deleteSnapshot(snapshot.id)
        }
      }
      await deps.db.prepare(`UPDATE provider_orphans SET deleted_at = ? WHERE kind = 'sandbox' AND provider_id = ?`).bind(now, box.name).run()
      summary.orphanSandboxesDeleted++
      log('orphan_sandbox_deleted', { name: box.name, d1: row ? row.status : 'missing', firstSeenAt: orphan.first_seen_at })
    } else if (box.status === 'running' && orphan.suspended_at === null) {
      // Stop the meter now; the automatic snapshot keeps the disk until the grace period ends.
      await deps.provider.stopSession(box.currentSessionId)
      await deps.db.prepare(`UPDATE provider_orphans SET suspended_at = ? WHERE kind = 'sandbox' AND provider_id = ?`).bind(now, box.name).run()
      summary.orphanSandboxesSuspended++
      log('orphan_sandbox_suspended', { name: box.name, d1: row ? row.status : 'missing' })
    }
  }
  if (!listing.complete) {
    log('orphan_sweep_partial', { listed: listing.sandboxes.length })
    return
  }
  // D1 says it exists, the provider does not: reported, never auto-repaired (wake fails cleanly).
  for (const row of await listByStatus(deps.db, ['running', 'suspended'])) {
    if (row.provider_name.startsWith(`orca-${env}-`) && !providerNames.has(row.provider_name) && now - row.updated_at > grace) {
      summary.rowsMissingProvider++
    }
  }
  await sweepSnapshots(deps, listing.sandboxes.map((s) => s.name), summary)
}

/** Automatic snapshots whose sandbox no longer exists anywhere in the project. Golden (manual) ones are never touched. */
async function sweepSnapshots(deps: LifecycleDeps, sandboxNames: string[], summary: HousekeepingSummary) {
  const now = deps.now()
  const grace = retention(deps).orphanGraceMs
  if (sandboxNames.length > 500) {
    log('orphan_snapshot_sweep_skipped', { sandboxes: sandboxNames.length })
    return
  }
  const listed = await deps.provider.listProjectSnapshots()
  if (!listed.complete) {
    log('orphan_snapshot_sweep_partial', { listed: listed.snapshots.length })
    return
  }
  const owned = new Set<string>(goldenSnapshotIds(deps.config))
  for (const name of sandboxNames) {
    for (const snapshot of await deps.provider.listSnapshots(name)) {
      owned.add(snapshot.id)
    }
  }
  const { results } = await deps.db
    .prepare(
      `SELECT ss.snapshot_id FROM sandbox_snapshots ss JOIN sandboxes s ON s.id = ss.sandbox_id
       WHERE ss.deleted_at IS NULL AND s.status <> 'destroyed'`
    )
    .all<{ snapshot_id: string }>()
  for (const r of results) {
    owned.add(r.snapshot_id)
  }
  for (const snapshot of listed.snapshots) {
    if (snapshot.status !== 'created' || snapshot.creationMethod !== 'automatic' || owned.has(snapshot.id)) {
      if (owned.has(snapshot.id)) {
        await clearOrphan(deps.db, 'snapshot', snapshot.id)
      }
      continue
    }
    summary.orphanSnapshotsSeen++
    const orphan = await upsertOrphan(deps.db, 'snapshot', snapshot.id, now)
    if (orphan.deleted_at === null && now - orphan.first_seen_at >= grace) {
      await deps.provider.deleteSnapshot(snapshot.id)
      await deps.db.prepare(`UPDATE provider_orphans SET deleted_at = ? WHERE kind = 'snapshot' AND provider_id = ?`).bind(now, snapshot.id).run()
      summary.orphanSnapshotsDeleted++
      log('orphan_snapshot_deleted', { id: snapshot.id, createdAt: snapshot.createdAt, firstSeenAt: orphan.first_seen_at })
    }
  }
}

// ---- entry points ----

/** Kill switch drain: snapshot-preserving suspend of every running sandbox (one batch per call). */
export async function drainAll(deps: LifecycleDeps): Promise<{ suspended: number; failed: number; remaining: number }> {
  let suspended = 0
  let failed = 0
  for (const row of await listByStatus(deps.db, ['running'])) {
    try {
      await suspendSandbox(deps, row)
      suspended++
    } catch {
      failed++
    }
  }
  const remaining = (await listByStatus(deps.db, ACTIVE_STATUSES)).length
  log('drain_all', { suspended, failed, remaining })
  return { suspended, failed, remaining }
}

/** Runs at most once per sweep interval; each part is isolated so one failure does not stop the rest. */
export async function housekeeping(
  deps: LifecycleDeps,
  options: { force?: boolean; notifier?: RetentionNotifier } = {}
): Promise<HousekeepingSummary> {
  const summary: HousekeepingSummary = {
    swept: false,
    orphanSandboxesSuspended: 0,
    orphanSandboxesDeleted: 0,
    orphanSnapshotsSeen: 0,
    orphanSnapshotsDeleted: 0,
    rowsMissingProvider: 0,
    holdsOpened: 0,
    holdsCleared: 0,
    retentionWarnings: 0,
    retentionDestroyed: 0,
    idleWarnings: 0,
    idleDestroyed: 0
  }
  const now = deps.now()
  const last = Number((await getControlState(deps.db, 'housekeeping_at')) ?? 0)
  if (!options.force && now - last < retention(deps).sweepIntervalMs) {
    return summary
  }
  await setControlState(deps.db, 'housekeeping_at', String(now), now)
  summary.swept = true
  const notifier = options.notifier ?? LOG_NOTIFIER
  for (const step of [
    () => sweepOrphans(deps, summary),
    () => probeHolds(deps, summary),
    () => enforceHolds(deps, notifier, summary),
    () => enforceIdle(deps, notifier, summary)
  ]) {
    try {
      await step()
    } catch (error) {
      log('housekeeping_step_failed', { message: error instanceof Error ? error.message : 'unknown' })
    }
  }
  return summary
}

/** Environment build snapshots are shared images, kept by environment-builds.ts retention only. */
async function isEnvironmentBuildSnapshot(db: D1Database, snapshotId: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS hit FROM environment_builds WHERE snapshot_id = ?').bind(snapshotId).first<{ hit: number }>()
  return row !== null
}
