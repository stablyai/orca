// Persistence for Codex code-audit runs (Phase 7): admission, lookup, and the
// candidate-currency re-check that gates every spawn.
//
// The invariant this file exists to hold: a `running` audit row is created ONLY
// while the task rests in awaiting_code_audit, the candidate it names is still
// the task's current one by both id and tree OID, and NO Claude execution is live
// for the task.
//
// That last clause is Phase 7-specific and load-bearing. A `fix` run's active
// state IS awaiting_code_audit, so "the task is in the audit state and has a
// current candidate" is satisfied WHILE Claude is editing the worktree. Admitting
// an audit there would spawn Codex against a moving tree.
import { toAuditMode, type AuditMode } from '../../shared/audited-audit-mode-types'
import type Database from '../sqlite/sync-database'
import type {
  CodeAuditReasonCode,
  CodeAuditRunStatus,
  CodeAuditVerdict
} from '../../shared/audited-code-audit-types'
import { hasLiveExecutionRun } from './audited-execution-run-repository'

export type CodeAuditRunRow = {
  id: string
  taskId: string
  candidateId: string
  candidateTreeOid: string
  round: number
  status: CodeAuditRunStatus
  verdict: CodeAuditVerdict | null
  reasonCode: CodeAuditReasonCode | null
  /** HOW this run reached its model. NULL in the DB reads as `codex_cli`. */
  auditMode: AuditMode
  findingCount: number | null
  summary: string | null
  exitCode: number | null
  stdoutBytes: number
  stderrBytes: number
  outputTruncated: boolean
  worktreeVerifiedAt: number
  startedAt: number
  endedAt: number | null
}

export function sqliteRowToCodeAuditRun(row: Record<string, unknown>): CodeAuditRunRow {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    candidateId: row.candidate_id as string,
    candidateTreeOid: row.candidate_tree_oid as string,
    round: row.round as number,
    status: row.status as CodeAuditRunStatus,
    verdict: (row.verdict as CodeAuditVerdict | null) ?? null,
    reasonCode: (row.reason_code as CodeAuditReasonCode | null) ?? null,
    // toAuditMode owns the NULL default, so a pre-v11 row reads as `codex_cli`
    // in one place rather than at each call site.
    auditMode: toAuditMode(row.audit_mode),
    findingCount: (row.finding_count as number | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    exitCode: (row.exit_code as number | null) ?? null,
    stdoutBytes: row.stdout_bytes as number,
    stderrBytes: row.stderr_bytes as number,
    outputTruncated: Boolean(row.output_truncated),
    worktreeVerifiedAt: row.worktree_verified_at_ms as number,
    startedAt: row.started_at_ms as number,
    endedAt: (row.ended_at_ms as number | null) ?? null
  }
}

export function generateCodeAuditRunId(): string {
  const hex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `cra_${hex}`
}

export function getCodeAuditRun(db: Database.Database, runId: string): CodeAuditRunRow | null {
  const row = db.prepare(`SELECT * FROM audited_code_audit_runs WHERE id = ?`).get(runId) as
    | Record<string, unknown>
    | undefined
  return row ? sqliteRowToCodeAuditRun(row) : null
}

export function getRunningCodeAuditRun(
  db: Database.Database,
  taskId: string
): CodeAuditRunRow | null {
  const row = db
    .prepare(`SELECT * FROM audited_code_audit_runs WHERE task_id = ? AND status = 'running'`)
    .get(taskId) as Record<string, unknown> | undefined
  return row ? sqliteRowToCodeAuditRun(row) : null
}

export function getLatestCodeAuditRun(
  db: Database.Database,
  taskId: string
): CodeAuditRunRow | null {
  const row = db
    .prepare(
      `SELECT * FROM audited_code_audit_runs WHERE task_id = ?
        ORDER BY started_at_ms DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as Record<string, unknown> | undefined
  return row ? sqliteRowToCodeAuditRun(row) : null
}

export type StartCodeAuditRunArgs = {
  taskId: string
  candidateId: string
  /** The tree OID the run will be JUDGED against at finalization. */
  candidateTreeOid: string
  round: number
  worktreeVerifiedAtMs: number
  /** The verified identity this launch depends on; re-checked inside the CAS. */
  expectedWorktreeIdentity: ExpectedWorktreeIdentity
  /** The transport, resolved before admission and recorded on the row. */
  auditMode: AuditMode
}

/**
 * The complete durable worktree identity a launch depends on. Compared as a whole
 * inside the admission transaction, so a mutation to any part refuses the run.
 */
export type ExpectedWorktreeIdentity = {
  worktreePath: string
  branchName: string
  worktreeProvenance: string
  worktreeVerifiedAt: number
  worktreeReasonCode: null
}

export type StartCodeAuditRunResult =
  | { ok: true; runId: string; worktreePath: string }
  | { ok: false; reasonCode: CodeAuditReasonCode }

/**
 * CAS-PROTECTED ADMISSION.
 *
 * startCodeAudit necessarily verifies the worktree and recomputes the candidate
 * tree BEFORE it can open a write transaction, and a fix can start or a revision
 * can complete in that window. Reading first and inserting later without
 * re-checking would spawn Codex against a candidate that is already obsolete.
 *
 * Everything is re-verified HERE, inside BEGIN IMMEDIATE, immediately before the
 * insert:
 *   1. NO Claude execution is live — the fix-lane guard. Checked FIRST because it
 *      is the only one whose violation means the worktree is actively changing.
 *      A pre-admission check alone is advisory; only this one is authoritative.
 *   2. the task is still awaiting_code_audit;
 *   3. the chosen candidate is still the task's current_candidate_id;
 *   4. that candidate row is still status 'current';
 *   5. its tree OID still equals the OID being persisted into the run;
 *   6. the task's WORKTREE IDENTITY still matches, field for field.
 *
 * Any failure returns a closed code and inserts NOTHING, so no audit row exists
 * and the caller never reaches a spawn.
 */
export function startCodeAuditRun(
  db: Database.Database,
  args: StartCodeAuditRunArgs,
  nowMs: number
): StartCodeAuditRunResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    // Check 1 — the fix-lane guard, inside the transaction that inserts the row.
    if (hasLiveExecutionRun(db, args.taskId)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'execution_in_progress' }
    }

    const task = db
      .prepare(
        `SELECT state, current_candidate_id, worktree_path, branch_name,
                worktree_provenance, worktree_verified_at_ms, worktree_reason_code
           FROM audited_tasks WHERE id = ?`
      )
      .get(args.taskId) as
      | {
          state: string
          current_candidate_id: string | null
          worktree_path: string | null
          branch_name: string | null
          worktree_provenance: string | null
          worktree_verified_at_ms: number | null
          worktree_reason_code: string | null
        }
      | undefined
    if (!task) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    if (task.state !== 'awaiting_code_audit') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    if (task.current_candidate_id !== args.candidateId) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'candidate_superseded' }
    }

    const expected = args.expectedWorktreeIdentity
    if (
      task.worktree_path !== expected.worktreePath ||
      task.branch_name !== expected.branchName ||
      task.worktree_provenance !== expected.worktreeProvenance ||
      task.worktree_verified_at_ms !== expected.worktreeVerifiedAt ||
      task.worktree_reason_code !== null
    ) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'worktree_identity_changed' }
    }

    const candidate = db
      .prepare(`SELECT status, tree_oid FROM audited_candidates WHERE id = ?`)
      .get(args.candidateId) as { status: string; tree_oid: string } | undefined
    if (!candidate || candidate.status !== 'current') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'candidate_superseded' }
    }
    // Not redundant with the id check: an id can match while the row was
    // rewritten. Comparing the OID the run will be judged against to the one
    // stored now is what makes admission and finalization refer to the same tree.
    if (candidate.tree_oid !== args.candidateTreeOid) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'candidate_drift' }
    }

    const runId = generateCodeAuditRunId()
    try {
      db.prepare(
        `INSERT INTO audited_code_audit_runs
           (id, task_id, candidate_id, candidate_tree_oid, round, status,
            audit_mode, worktree_verified_at_ms, started_at_ms)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`
      ).run(
        runId,
        args.taskId,
        args.candidateId,
        args.candidateTreeOid,
        args.round,
        // WRITTEN AT ADMISSION, not at finalization. The row carries its
        // transport from birth, so an interrupted run — which never reaches a
        // finalize — is still attributable to the mode that produced it.
        args.auditMode,
        args.worktreeVerifiedAtMs,
        nowMs
      )
    } catch {
      // The partial unique index rejected a concurrent duplicate start — the last
      // line of defense against two Codex processes for one task.
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    db.exec('COMMIT')
    // The cwd the caller must spawn with: read INSIDE this transaction and proven
    // to match the verified identity. A captured path is never authoritative.
    return { ok: true, runId, worktreePath: task.worktree_path! }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
