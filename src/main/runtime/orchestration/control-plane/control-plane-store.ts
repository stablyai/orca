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
import { ControlPlaneLeaseStore } from './control-plane-lease-store'
import type {
  GateExecutionAuthorityRow,
  GateExecutionRow,
  OutcomeRelationRow,
  OutcomeRow,
  RequiredGateSpecRow,
  ValidationLeaseAuthorityRow
} from './control-plane-rows'

export class ControlPlaneStore extends ControlPlaneLeaseStore {
  /** `handle` and the `db` accessor — for callers that must wrap several store
   *  writes in one transaction (atomic outcome intake) — come from the base. */

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
        `INSERT INTO control_plane_outcome_relations
           (left_outcome_id, right_outcome_id, kind, decision, rationale)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(row.left_outcome_id, row.right_outcome_id, row.kind, row.decision, row.rationale)
  }

  closeOutcome(outcomeId: string): void {
    this.handle.db
      .prepare("UPDATE control_plane_outcomes SET status = 'closed' WHERE outcome_id = ?")
      .run(outcomeId)
  }

  getValidationLeaseAuthority(
    scopeKey: string,
    leaseId: string
  ): ValidationLeaseAuthorityRow | undefined {
    return this.handle.db
      .prepare(
        `SELECT * FROM control_plane_validation_lease_authority
         WHERE scope_key = ? AND lease_id = ?`
      )
      .get(scopeKey, leaseId) as ValidationLeaseAuthorityRow | undefined
  }

  insertValidationLeaseAuthority(row: ValidationLeaseAuthorityRow): void {
    this.handle.db
      .prepare(
        `INSERT INTO control_plane_validation_lease_authority
           (scope_key, lease_id, run_id, outcome_id, task_id, dispatch_id, worktree_id,
            owner_handle, owner_pane_key, process_incarnation, launch_token_hash,
            runtime_id, build_id, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.scope_key,
        row.lease_id,
        row.run_id,
        row.outcome_id,
        row.task_id,
        row.dispatch_id,
        row.worktree_id,
        row.owner_handle,
        row.owner_pane_key,
        row.process_incarnation,
        row.launch_token_hash,
        row.runtime_id,
        row.build_id,
        row.expires_at
      )
  }

  insertRequiredGateSpec(row: RequiredGateSpecRow): void {
    this.handle.db
      .prepare(
        `INSERT INTO control_plane_required_gate_specs
           (outcome_id, gate_id, program, args_json, dependencies_json, policy_version,
            command_identity, sha_binding, spec_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.outcome_id,
        row.gate_id,
        row.program,
        row.args_json,
        row.dependencies_json,
        row.policy_version,
        row.command_identity,
        row.sha_binding,
        row.spec_hash
      )
  }

  getRequiredGateSpec(outcomeId: string, gateId: string): RequiredGateSpecRow | undefined {
    return this.handle.db
      .prepare(
        'SELECT * FROM control_plane_required_gate_specs WHERE outcome_id = ? AND gate_id = ?'
      )
      .get(outcomeId, gateId) as RequiredGateSpecRow | undefined
  }

  findRequiredGateSpecByCommandIdentity(
    outcomeId: string,
    commandIdentity: string
  ): RequiredGateSpecRow | undefined {
    return this.handle.db
      .prepare(
        `SELECT * FROM control_plane_required_gate_specs
         WHERE outcome_id = ? AND command_identity = ? LIMIT 1`
      )
      .get(outcomeId, commandIdentity) as RequiredGateSpecRow | undefined
  }

  listRequiredGateSpecs(outcomeId: string): RequiredGateSpecRow[] {
    return this.handle.db
      .prepare(
        'SELECT * FROM control_plane_required_gate_specs WHERE outcome_id = ? ORDER BY gate_id'
      )
      .all(outcomeId) as RequiredGateSpecRow[]
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

  recordGateExecutionAuthority(row: GateExecutionAuthorityRow): void {
    this.handle.db
      .prepare(
        `INSERT INTO control_plane_gate_execution_authority
           (execution_id, run_id, outcome_id, dispatch_id, worktree_id, build_id,
            policy_version, command_identity, spec_hash, input_hashes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.execution_id,
        row.run_id,
        row.outcome_id,
        row.dispatch_id,
        row.worktree_id,
        row.build_id,
        row.policy_version,
        row.command_identity,
        row.spec_hash,
        row.input_hashes
      )
  }

  /** A successful runtime-owned execution of this gate at this exact SHA. */
  findSuccessfulGateExecution(args: {
    scopeKey: string
    gateId: string
    finalSha?: string
    buildId?: string
    runId?: string
    outcomeId?: string
    dispatchId?: string
    worktreeId?: string
    specHash?: string
    inputHashes?: string
  }): GateExecutionRow | undefined {
    const clauses = ['execution.scope_key = ?', 'execution.gate_id = ?', 'execution.exit_code = 0']
    const values: Database.BindValue[] = [args.scopeKey, args.gateId]
    if (args.finalSha !== undefined) {
      clauses.push('execution.final_sha = ?')
      values.push(args.finalSha)
    }
    const authorityFields: [keyof typeof args, string][] = [
      ['buildId', 'authority.build_id'],
      ['runId', 'authority.run_id'],
      ['outcomeId', 'authority.outcome_id'],
      ['dispatchId', 'authority.dispatch_id'],
      ['worktreeId', 'authority.worktree_id'],
      ['specHash', 'authority.spec_hash'],
      ['inputHashes', 'authority.input_hashes']
    ]
    for (const [key, column] of authorityFields) {
      const value = args[key]
      if (value !== undefined) {
        clauses.push(`${column} = ?`)
        values.push(value)
      }
    }
    const requiresAuthority = authorityFields.some(([key]) => args[key] !== undefined)
    return this.handle.db
      .prepare(
        `SELECT execution.* FROM control_plane_gate_executions AS execution
         ${requiresAuthority ? 'JOIN control_plane_gate_execution_authority AS authority ON authority.execution_id = execution.execution_id' : ''}
         WHERE ${clauses.join(' AND ')}
         ORDER BY execution.rowid DESC LIMIT 1`
      )
      .get(...values) as GateExecutionRow | undefined
  }

  getGateExecutionAuthority(executionId: string): GateExecutionAuthorityRow | undefined {
    return this.handle.db
      .prepare('SELECT * FROM control_plane_gate_execution_authority WHERE execution_id = ?')
      .get(executionId) as GateExecutionAuthorityRow | undefined
  }

  getIntakeBatch(batchId: string): { batch_id: string; manifest_fingerprint: string } | undefined {
    return this.handle.db
      .prepare('SELECT * FROM control_plane_intake_batches WHERE batch_id = ?')
      .get(batchId) as { batch_id: string; manifest_fingerprint: string } | undefined
  }

  putIntakeBatch(row: { batch_id: string; manifest_fingerprint: string }): void {
    this.handle.db
      .prepare(
        `INSERT INTO control_plane_intake_batches (batch_id, manifest_fingerprint)
         VALUES (?, ?)`
      )
      .run(row.batch_id, row.manifest_fingerprint)
  }

  getIntakeManifest(
    batchId: string
  ): { batch_id: string; schema_version: number; manifest_json: string } | undefined {
    return this.handle.db
      .prepare('SELECT * FROM control_plane_intake_manifests WHERE batch_id = ?')
      .get(batchId) as
      | { batch_id: string; schema_version: number; manifest_json: string }
      | undefined
  }

  putIntakeManifest(row: {
    batch_id: string
    schema_version: number
    manifest_json: string
  }): void {
    this.handle.db
      .prepare(
        `INSERT INTO control_plane_intake_manifests (batch_id, schema_version, manifest_json)
         VALUES (?, ?, ?)`
      )
      .run(row.batch_id, row.schema_version, row.manifest_json)
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
}
