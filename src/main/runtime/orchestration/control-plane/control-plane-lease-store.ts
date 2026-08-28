import type Database from '../../../sqlite/sync-database'
import { createControlPlaneTablesSql } from './control-plane-tables-sql'

/** Structural handle so the store works against the real OrchestrationDb and
 *  against a bare in-memory database in tests without importing either. */
export type ControlPlaneDatabaseHandle = { db: Database.Database }

// Why once per handle: `CREATE TABLE` is schema-changing DDL, and the SQLite
// adapter drops its whole prepared-statement cache on any such exec. Running it
// per store construction would clear that cache on every worker_done. The
// tables are normally created by createTables() at OrchestrationDb construction;
// this only covers a handle that never went through it.
const ENSURED_HANDLES = new WeakSet<object>()

export function ensureControlPlaneTables(handle: ControlPlaneDatabaseHandle): void {
  if (ENSURED_HANDLES.has(handle.db)) {
    return
  }
  handle.db.exec(createControlPlaneTablesSql())
  ENSURED_HANDLES.add(handle.db)
}

export * from './control-plane-rows'
import type { GateReceiptRow, LivenessMarkerRow, ValidationLeaseRow } from './control-plane-rows'

/** The liveness-marker, gate-receipt and validation-lease half of the control
 *  plane store.
 *
 *  A base class rather than free functions so `ControlPlaneStore` keeps exactly
 *  the shape every caller already uses; the split is by size, not by contract.
 */
export class ControlPlaneLeaseStore {
  protected readonly handle: ControlPlaneDatabaseHandle

  constructor(handle: ControlPlaneDatabaseHandle) {
    this.handle = handle
    ensureControlPlaneTables(handle)
  }

  get db(): ControlPlaneDatabaseHandle['db'] {
    return this.handle.db
  }

  getLivenessMarker(dispatchId: string): LivenessMarkerRow | undefined {
    return this.handle.db
      .prepare('SELECT * FROM control_plane_dispatch_liveness WHERE dispatch_id = ?')
      .get(dispatchId) as LivenessMarkerRow | undefined
  }

  putLivenessMarker(row: LivenessMarkerRow): void {
    this.handle.db
      .prepare(
        `INSERT INTO control_plane_dispatch_liveness
           (dispatch_id, verdict, activity, reason, observed_at, expires_at, epoch, woke_for, terminal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dispatch_id) DO UPDATE SET
           verdict = excluded.verdict,
           activity = excluded.activity,
           reason = excluded.reason,
           observed_at = excluded.observed_at,
           expires_at = excluded.expires_at,
           epoch = excluded.epoch,
           woke_for = excluded.woke_for,
           terminal = excluded.terminal
         WHERE control_plane_dispatch_liveness.terminal = 0`
      )
      .run(
        row.dispatch_id,
        row.verdict,
        row.activity,
        row.reason,
        row.observed_at,
        row.expires_at,
        row.epoch,
        row.woke_for,
        row.terminal
      )
  }

  // --- B8 gate receipts ----------------------------------------------------

  putGateReceipt(row: GateReceiptRow): void {
    this.handle.db
      .prepare(
        `INSERT OR REPLACE INTO control_plane_gate_receipts
           (receipt_id, scope_key, gate_id, final_sha, input_hashes, policy_version,
            command_identity, result, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.receipt_id,
        row.scope_key,
        row.gate_id,
        row.final_sha,
        row.input_hashes,
        row.policy_version,
        row.command_identity,
        row.result,
        row.recorded_at
      )
  }

  listGateReceipts(scopeKey: string): GateReceiptRow[] {
    return this.handle.db
      .prepare(
        'SELECT * FROM control_plane_gate_receipts WHERE scope_key = ? ORDER BY recorded_at DESC'
      )
      .all(scopeKey) as GateReceiptRow[]
  }

  // --- B9 validation leases -------------------------------------------------

  getValidationLease(scopeKey: string): ValidationLeaseRow | undefined {
    return this.handle.db
      .prepare('SELECT * FROM control_plane_validation_leases WHERE scope_key = ?')
      .get(scopeKey) as ValidationLeaseRow | undefined
  }

  /** Whether ANY lease is live right now. The mutation fence asks this first so
   *  the common no-lease case costs one indexed read instead of resolving a
   *  worktree selector on every mutating RPC. */
  hasAnyActiveValidationLease(nowIso?: string): boolean {
    return (
      this.handle.db
        .prepare(
          `SELECT 1 FROM control_plane_validation_leases
           WHERE released_at IS NULL AND expires_at > ? LIMIT 1`
        )
        .get(nowIso ?? new Date().toISOString()) !== undefined
    )
  }

  /** Any live lease this Dispatch owns, whatever scope it was taken on. */
  findValidationLeaseByOwner(owner: string, nowIso?: string): ValidationLeaseRow | undefined {
    return this.handle.db
      .prepare(
        // Why the expiry filter: an expired lease is not a live credential, and
        // returning one let a stale holder re-enter a scope it no longer owns.
        `SELECT * FROM control_plane_validation_leases
         WHERE owner = ? AND released_at IS NULL AND expires_at > ?`
      )
      .get(owner, nowIso ?? new Date().toISOString()) as ValidationLeaseRow | undefined
  }

  putValidationLease(row: ValidationLeaseRow): void {
    this.handle.db
      .prepare(
        `INSERT OR REPLACE INTO control_plane_validation_leases
           (scope_key, lease_id, owner, idempotency_key, acquired_at, expires_at, released_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.scope_key,
        row.lease_id,
        row.owner,
        row.idempotency_key,
        row.acquired_at,
        row.expires_at,
        row.released_at
      )
  }

  releaseValidationLease(scopeKey: string, leaseId: string, releasedAt: string): void {
    this.handle.db
      .prepare(
        'UPDATE control_plane_validation_leases SET released_at = ? WHERE scope_key = ? AND lease_id = ?'
      )
      .run(releasedAt, scopeKey, leaseId)
  }
}
