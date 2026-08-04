// Bridges a SUCCESSFUL Claude implement-or-fix run to its durable candidate
// (Phase 7). The direct-mode counterpart of completePlanRun.
//
// Every branch still finalizes the execution run truthfully. That is the whole
// contract: an implement run must never be left `running`, and a task must never
// reach awaiting_code_audit without a candidate behind it — otherwise the audit
// lane would offer "Run Code Audit" for work whose identity nobody computed.
import type Database from '../sqlite/sync-database'
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import type { AuditedTaskRow } from './audited-task-row-mapping'
import { finalizeExecutionRun } from './audited-execution-run-finalize'
import { attachCandidate, generateCandidateId } from './audited-candidate-repository'
import { deriveCandidateTree } from './audited-candidate-identity'

export type ImplementRunCompletionArgs = {
  runId: string
  taskId: string
  task: AuditedTaskRow
  userDataPath: string
  /** 'implementing' for a direct run, 'awaiting_code_audit' for a fix run. */
  activeRunState: AuditedTaskState
  counters: {
    stdoutBytes: number
    stderrBytes: number
    outputTruncated: boolean
    exitCode: number | null
  }
}

export type ImplementRunCompletionResult =
  | { ok: true; candidateId: string }
  | { ok: false; kind: 'derivation_failed' | 'empty' | 'not_owner' | 'contended' }

/**
 * Completes a successful implement or fix run.
 *
 * The tree is derived OUTSIDE any transaction — Git spawns cannot be inside one —
 * and attachCandidate then re-checks ownership, task state, transition legality,
 * and the no-live-audit guard before writing anything.
 *
 * On attach success the candidate transaction ALSO finalizes the execution run
 * and moves the task, so no separate finalizeExecutionRun call is made.
 *
 * On a derivation failure the run is finalized here as a failure and the task is
 * blocked, so it cannot advance without a candidate.
 *
 * On `not_owner` / `contended` NOTHING is written: a cancel, a startup recovery,
 * an invariant block, or a live code audit already owns this outcome, and
 * overwriting it would erase the winner's truthful record.
 */
export async function completeImplementRun(
  db: Database.Database,
  args: ImplementRunCompletionArgs,
  nowMs: number
): Promise<ImplementRunCompletionResult> {
  const { task } = args
  // The lane-specific process-failure code, so a blocked fix does not report
  // itself as a failed implement.
  const processFailed =
    args.activeRunState === 'implementing' ? 'implement_process_failed' : 'fix_process_failed'

  if (!task.worktreePath || !task.branchName) {
    return blockRun(db, args, 'worktree_not_verified', processFailed, nowMs, {
      ok: false,
      kind: 'derivation_failed'
    })
  }

  const derived = await deriveCandidateTree({
    runId: args.runId,
    userDataPath: args.userDataPath,
    worktreePath: task.worktreePath,
    sourceRepoPath: task.sourceRepoPath,
    baseCommit: task.baseCommit,
    wslDistro: task.wslDistro,
    hostId: task.hostId
  })

  if (!derived.ok) {
    // An empty change set is a distinct, honest outcome: the run succeeded but
    // produced nothing to audit. Both paths block, with different reasons.
    const isEmpty = derived.reasonCode === 'empty_change_set'
    const isUnsupportedHost = derived.reasonCode === 'candidate_host_unsupported'
    return blockRun(
      db,
      args,
      isEmpty ? 'empty_output' : 'spawn_failed',
      isEmpty ? 'empty_change_set' : isUnsupportedHost ? 'unsupported_host' : processFailed,
      nowMs,
      { ok: false, kind: isEmpty ? 'empty' : 'derivation_failed' }
    )
  }

  const attached = attachCandidate(
    db,
    {
      candidateId: generateCandidateId(),
      taskId: args.taskId,
      runId: args.runId,
      round: task.fixRound,
      treeOid: derived.treeOid,
      baseCommit: task.baseCommit,
      branchName: task.branchName,
      activeRunState: args.activeRunState,
      counters: args.counters
    },
    nowMs
  )

  if (attached.ok) {
    return { ok: true, candidateId: attached.task.currentCandidateId! }
  }

  // A live audit or a lost race: the run row is deliberately left for its real
  // owner (cancel/recovery) or, for code_audit_in_progress, finalized as blocked
  // so it is never abandoned in `running`.
  if (attached.reasonCode === 'code_audit_in_progress') {
    // A live audit owns the current candidate. The fix's work is real but cannot
    // be attached without invalidating that audit mid-flight, so the run is
    // blocked truthfully; retrying once the audit finishes re-derives.
    return blockRun(db, args, 'lock_contended', processFailed, nowMs, {
      ok: false,
      kind: 'contended'
    })
  }
  return { ok: false, kind: 'not_owner' }
}

/**
 * Finalizes a run that produced no usable candidate, blocking the task.
 *
 * The run row already exists, so abandoning it would leave a `running` row with
 * no process — which startup recovery would later reclassify as `interrupted`, a
 * less truthful outcome than the reason we actually know.
 */
function blockRun(
  db: Database.Database,
  args: ImplementRunCompletionArgs,
  reasonCode: 'empty_output' | 'spawn_failed' | 'worktree_not_verified' | 'lock_contended',
  blockedReasonCode: string,
  nowMs: number,
  result: ImplementRunCompletionResult
): ImplementRunCompletionResult {
  finalizeExecutionRun(
    db,
    {
      runId: args.runId,
      taskId: args.taskId,
      status: 'failed',
      reasonCode,
      toState: 'blocked',
      blockedReasonCode,
      preBlockState: args.activeRunState,
      blockedPhase: 'execution',
      eventType: 'execution_blocked',
      counters: args.counters
    },
    nowMs
  )
  return result
}
