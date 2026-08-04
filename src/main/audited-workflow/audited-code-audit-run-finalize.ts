// Finalization of a Codex code-audit run (Phase 7).
//
// TWO PERMISSIONS WITH DIFFERENT WRITE SCOPES, mirroring finalizePlanReviewRun:
//
//   A — RUN OWNERSHIP: is this audit row still `running` and still mine?
//       Authorizes writing THIS RUN ROW's terminal status/verdict/counters.
//
//   B — FRESHNESS: is the run's candidate still the task's current one (by id AND
//       tree OID), and is the task still awaiting_code_audit?
//       Authorizes writing THE TASK.
//
// When A holds but B does not, the run is finalized `failed` with
// candidate_superseded / candidate_drift / task_state_changed and the task is
// left byte-identical. `verdict` is stored NULL on every stale path on purpose: a
// durable `approved` row that no longer refers to the current tree is exactly the
// artifact a future bug could mistake for authorization.
//
// THE DRIFT CHECK IS A RECOMPUTATION, NOT A HASH COMPARE. A plan artifact is
// bytes on disk, so comparing a stored sha256 proves the reviewed content is
// unchanged. A candidate is DERIVED state, so the only equivalent is deriving it
// again — which the caller does before calling here and passes as
// `recomputedTreeOid`.
import type Database from '../sqlite/sync-database'
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import type {
  CodeAuditReasonCode,
  CodeAuditRunStatus,
  CodeAuditVerdict
} from '../../shared/audited-code-audit-types'
import { getCodeAuditRun } from './audited-code-audit-run-repository'
import {
  validateAuditedTransition,
  validateBlockTransition
} from './audited-workflow-state-machine'

export type CodeAuditOutputCounters = {
  stdoutBytes: number
  stderrBytes: number
  outputTruncated: boolean
  exitCode: number | null
}

export type FinalizeCodeAuditArgs = {
  runId: string
  taskId: string
  status: Exclude<CodeAuditRunStatus, 'running'>
  reasonCode: CodeAuditReasonCode | null
  /** Null unless this run legitimately produced one. */
  verdict: CodeAuditVerdict | null
  summary: string | null
  findingCount: number | null
  /** Where the task should land. Null means "leave the task alone". */
  toState: AuditedTaskState | null
  blockedReasonCode: string | null
  preBlockState: AuditedTaskState | null
  blockedPhase: string | null
  eventType: string
  counters: CodeAuditOutputCounters
  /**
   * The tree OID re-derived from the live worktree AFTER the audit finished, or
   * null when the caller could not derive one (which is itself treated as drift).
   */
  recomputedTreeOid: string | null
}

export type FinalizeCodeAuditResult =
  | { ok: true; taskWritten: boolean }
  | { ok: false; reasonCode: 'task_not_found' | 'lock_contended' }

/**
 * Resolves the state-machine command authorizing a verdict-driven task move, so
 * this path can never write a state the state machine would refuse.
 */
function validateAuditTransition(from: AuditedTaskState, to: AuditedTaskState): boolean {
  if (to === 'blocked') {
    return validateBlockTransition(from).ok
  }
  const command =
    from === 'awaiting_code_audit' && to === 'awaiting_human_approval'
      ? 'codeAuditApprove'
      : from === 'awaiting_code_audit' && to === 'code_fixes_requested'
        ? 'codeAuditFixesRequested'
        : null
  if (command === null) {
    return false
  }
  const validation = validateAuditedTransition(command, from)
  return validation.ok && validation.rule.to === to
}

/**
 * Finalizes an audit run, and moves the task only if permission B holds.
 */
export function finalizeCodeAuditRun(
  db: Database.Database,
  args: FinalizeCodeAuditArgs,
  nowMs: number
): FinalizeCodeAuditResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const task = db
      .prepare(`SELECT state, current_candidate_id FROM audited_tasks WHERE id = ?`)
      .get(args.taskId) as { state: string; current_candidate_id: string | null } | undefined
    if (!task) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'task_not_found' }
    }

    // ---- Permission A: run ownership. Checked before ANY write. ----
    const run = getCodeAuditRun(db, args.runId)
    if (!run || run.taskId !== args.taskId || run.status !== 'running') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    // ---- Permission B: freshness. Decides only whether the TASK may move. ----
    const freshness = evaluateFreshness(db, {
      taskState: task.state,
      taskCandidateId: task.current_candidate_id,
      runCandidateId: run.candidateId,
      runTreeOid: run.candidateTreeOid,
      recomputedTreeOid: args.recomputedTreeOid
    })

    const effective =
      freshness === null
        ? { status: args.status, reasonCode: args.reasonCode, verdict: args.verdict }
        : { status: 'failed' as const, reasonCode: freshness, verdict: null }

    const runUpdate = db
      .prepare(
        `UPDATE audited_code_audit_runs
            SET status = ?, reason_code = ?, verdict = ?, summary = ?, finding_count = ?,
                exit_code = ?, stdout_bytes = ?, stderr_bytes = ?, output_truncated = ?,
                ended_at_ms = ?
          WHERE id = ? AND task_id = ? AND status = 'running'`
      )
      .run(
        effective.status,
        effective.reasonCode,
        effective.verdict,
        args.summary,
        args.findingCount,
        args.counters.exitCode,
        args.counters.stdoutBytes,
        args.counters.stderrBytes,
        args.counters.outputTruncated ? 1 : 0,
        nowMs,
        args.runId,
        args.taskId
      )
    if (runUpdate.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    // A stale run stops here: the audit row is terminal, the task is untouched.
    if (freshness !== null) {
      db.exec('COMMIT')
      return { ok: true, taskWritten: false }
    }

    if (args.toState === null) {
      db.exec('COMMIT')
      return { ok: true, taskWritten: false }
    }

    const fromState = task.state as AuditedTaskState
    if (!validateAuditTransition(fromState, args.toState)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    // An `approved` verdict binds the audited tree to the task. This is the FIRST
    // writer of audit_approved_tree_oid, declared since Phase 1 — and it is
    // written only here, only for the tree this run actually judged.
    const approvedTreeOid = args.verdict === 'approved' ? run.candidateTreeOid : null
    const taskUpdate = db
      .prepare(
        `UPDATE audited_tasks
            SET state = ?, code_audit_verdict = ?, audit_approved_tree_oid = ?,
                pre_block_state = ?, blocked_reason_code = ?, blocked_phase = ?,
                updated_at_ms = ?
          WHERE id = ? AND state = ?`
      )
      .run(
        args.toState,
        args.verdict,
        approvedTreeOid,
        args.preBlockState,
        args.blockedReasonCode,
        args.blockedPhase,
        nowMs,
        args.taskId,
        fromState
      )
    if (taskUpdate.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
    ).run(
      args.taskId,
      fromState,
      args.toState,
      args.toState === 'blocked' ? 'control' : 'codex',
      args.eventType,
      args.reasonCode,
      nowMs
    )

    db.exec('COMMIT')
    return { ok: true, taskWritten: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Returns null when the run is still fresh, or the closed code explaining why its
 * verdict may no longer touch the task.
 */
function evaluateFreshness(
  db: Database.Database,
  args: {
    taskState: string
    taskCandidateId: string | null
    runCandidateId: string
    runTreeOid: string
    recomputedTreeOid: string | null
  }
): 'candidate_superseded' | 'task_state_changed' | 'candidate_drift' | null {
  if (args.taskState !== 'awaiting_code_audit') {
    return 'task_state_changed'
  }
  if (args.taskCandidateId !== args.runCandidateId) {
    return 'candidate_superseded'
  }
  const candidate = db
    .prepare(`SELECT status, tree_oid FROM audited_candidates WHERE id = ?`)
    .get(args.runCandidateId) as { status: string; tree_oid: string } | undefined
  if (!candidate || candidate.status !== 'current') {
    return 'candidate_superseded'
  }
  if (candidate.tree_oid !== args.runTreeOid) {
    return 'candidate_superseded'
  }
  // The live worktree no longer produces the tree this run judged — someone
  // edited a file while Codex was reading it. A verdict about the old content
  // must not be recorded against the new content. A missing recomputation is
  // treated the same way: it is not proof of freshness.
  if (args.recomputedTreeOid !== args.runTreeOid) {
    return 'candidate_drift'
  }
  return null
}
