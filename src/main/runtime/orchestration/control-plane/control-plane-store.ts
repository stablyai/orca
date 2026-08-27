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

export type OutcomeRow = {
  outcome_id: string
  run_id: string
  title: string
  fingerprint: string
  intake_batch: string | null
  status: 'admitted' | 'closed'
  gate_policy: 'standard' | 'high_risk'
  created_at: string
}

export type GateExecutionRow = {
  execution_id: string
  scope_key: string
  gate_id: string
  final_sha: string
  command: string
  exit_code: number | null
  log_digest: string
  build_id: string
  started_at: string
  finished_at: string
}

export type OutcomeRelationRow = {
  left_outcome_id: string
  right_outcome_id: string
  kind: 'semantic_overlap' | 'resource_collision'
  decision: 'independent' | 'serialize' | 'merge'
  rationale: string
}

export type LivenessMarkerRow = {
  dispatch_id: string
  verdict: 'live' | 'unverifiable' | 'exited'
  activity: 'working' | 'blocked_on_approved_wait' | 'stalled' | 'crashed' | 'settled'
  reason: string
  observed_at: string
  expires_at: string
  epoch: string | null
  woke_for: string | null
  terminal: number
}

export type GateReceiptRow = {
  receipt_id: string
  scope_key: string
  gate_id: string
  final_sha: string
  input_hashes: string
  policy_version: string
  command_identity: string
  result: 'PASS' | 'FAIL'
  recorded_at: string
}

export type ValidationLeaseRow = {
  scope_key: string
  lease_id: string
  owner: string
  idempotency_key: string
  acquired_at: string
  expires_at: string
  released_at: string | null
}

/** Thin typed accessor over the additive control-plane tables. Every method is
 *  a single statement; the transaction boundary belongs to the caller so a
 *  multi-row admission stays atomic with the orchestration write it guards. */
export class ControlPlaneStore {
  private readonly handle: ControlPlaneDatabaseHandle

  constructor(handle: ControlPlaneDatabaseHandle) {
    this.handle = handle
    ensureControlPlaneTables(handle)
  }

  /** The underlying database, for callers that must wrap several store writes
   *  in one transaction (atomic outcome intake). */
  get db(): ControlPlaneDatabaseHandle['db'] {
    return this.handle.db
  }

  // --- B2 outcomes --------------------------------------------------------

  getOutcomeById(outcomeId: string): OutcomeRow | undefined {
    return this.handle.db
      .prepare('SELECT * FROM control_plane_outcomes WHERE outcome_id = ?')
      .get(outcomeId) as OutcomeRow | undefined
  }

  getOutcomeByRun(runId: string): OutcomeRow | undefined {
    return this.handle.db
      .prepare('SELECT * FROM control_plane_outcomes WHERE run_id = ?')
      .get(runId) as OutcomeRow | undefined
  }

  insertOutcome(row: Omit<OutcomeRow, 'created_at'>): void {
    this.handle.db
      .prepare(
        `INSERT INTO control_plane_outcomes
           (outcome_id, run_id, title, fingerprint, intake_batch, status, gate_policy)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.outcome_id,
        row.run_id,
        row.title,
        row.fingerprint,
        row.intake_batch,
        row.status,
        row.gate_policy
      )
  }

  insertOutcomeRelation(row: OutcomeRelationRow): void {
    this.handle.db
      .prepare(
        `INSERT OR REPLACE INTO control_plane_outcome_relations
           (left_outcome_id, right_outcome_id, kind, decision, rationale)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(row.left_outcome_id, row.right_outcome_id, row.kind, row.decision, row.rationale)
  }

  recordGateExecution(row: GateExecutionRow): void {
    this.handle.db
      .prepare(
        `INSERT OR REPLACE INTO control_plane_gate_executions
           (execution_id, scope_key, gate_id, final_sha, command, exit_code, log_digest,
            build_id, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.execution_id,
        row.scope_key,
        row.gate_id,
        row.final_sha,
        row.command,
        row.exit_code,
        row.log_digest,
        row.build_id,
        row.started_at,
        row.finished_at
      )
  }

  /** A successful runtime-owned execution of this gate at this exact SHA. */
  findSuccessfulGateExecution(args: {
    scopeKey: string
    gateId: string
    finalSha: string
  }): GateExecutionRow | undefined {
    return this.handle.db
      .prepare(
        `SELECT * FROM control_plane_gate_executions
         WHERE scope_key = ? AND gate_id = ? AND final_sha = ? AND exit_code = 0
         ORDER BY rowid DESC LIMIT 1`
      )
      .get(args.scopeKey, args.gateId, args.finalSha) as GateExecutionRow | undefined
  }

  getIntakeBatch(batchId: string): { batch_id: string; manifest_fingerprint: string } | undefined {
    return this.handle.db
      .prepare('SELECT * FROM control_plane_intake_batches WHERE batch_id = ?')
      .get(batchId) as { batch_id: string; manifest_fingerprint: string } | undefined
  }

  putIntakeBatch(row: { batch_id: string; manifest_fingerprint: string }): void {
    this.handle.db
      .prepare(
        `INSERT OR IGNORE INTO control_plane_intake_batches (batch_id, manifest_fingerprint)
         VALUES (?, ?)`
      )
      .run(row.batch_id, row.manifest_fingerprint)
  }

  listOutcomeRelations(outcomeId: string): OutcomeRelationRow[] {
    return this.handle.db
      .prepare(
        `SELECT * FROM control_plane_outcome_relations
         WHERE left_outcome_id = ? OR right_outcome_id = ?`
      )
      .all(outcomeId, outcomeId) as OutcomeRelationRow[]
  }

  // --- B4 liveness markers -------------------------------------------------

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
