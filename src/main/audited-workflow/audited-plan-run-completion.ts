// Bridges a SUCCESSFUL Claude plan run to its durable artifact (Phase 5).
//
// Split from audited-execution-orchestration.ts so that file stays under the
// max-lines budget and so the plan-mode success path — the only one that
// produces an artifact — has a single, testable entry point.
//
// Every branch still finalizes the execution run truthfully. That is the whole
// contract: a plan run must never be left `running`, and a task must never reach
// awaiting_plan_review without an artifact behind it.
import type Database from '../sqlite/sync-database'
import type { AuditedTaskRow } from './audited-task-row-mapping'
import { finalizeExecutionRun } from './audited-execution-run-finalize'
import {
  derivePlanArtifact,
  type PlanArtifactDerivationResult
} from './audited-plan-artifact-derivation'

export type PlanRunCompletionArgs = {
  runId: string
  taskId: string
  task: AuditedTaskRow
  rawPlanText: string
  userDataPath: string
  counters: {
    stdoutBytes: number
    stderrBytes: number
    outputTruncated: boolean
    exitCode: number | null
  }
}

export type PlanRunCompletionResult =
  | { ok: true; artifactId: string }
  | { ok: false; kind: 'empty' | 'write_failed' | 'not_owner' }

/**
 * Completes a successful plan run.
 *
 * On derivation success the artifact transaction ALSO finalizes the execution
 * run and moves the task, so no separate finalizeExecutionRun call is made —
 * doing both would double-write the run row.
 *
 * On `empty` / `write_failed` the run is finalized here as a failure and the
 * task is blocked, so it cannot advance without a plan.
 *
 * On `not_owner` NOTHING is written: a cancel, a startup recovery, or an
 * invariant block already finalized this run, and overwriting that would erase
 * the winner's truthful outcome.
 */
export function completePlanRun(
  db: Database.Database,
  args: PlanRunCompletionArgs,
  nowMs: number
): PlanRunCompletionResult {
  const derivation: PlanArtifactDerivationResult = derivePlanArtifact(
    db,
    args.userDataPath,
    {
      taskId: args.taskId,
      runId: args.runId,
      round: args.task.planRound,
      rawPlanText: args.rawPlanText,
      sanitizationContext: {
        worktreePath: args.task.worktreePath,
        sourceRepoPath: args.task.sourceRepoPath,
        sourceRepoCommonDir: args.task.sourceRepoCommonDir,
        branchName: args.task.branchName,
        userDataPath: args.userDataPath
      },
      counters: args.counters
    },
    nowMs
  )

  if (derivation.ok) {
    return { ok: true, artifactId: derivation.artifactId }
  }

  if (derivation.kind === 'not_owner') {
    return { ok: false, kind: 'not_owner' }
  }

  // Artifact-file failures reuse the EXISTING `spawn_failed` execution reason
  // rather than adding a code, so audited_execution_runs' CHECK constraint stays
  // untouched and the v5 migration needs no table rebuild. The precise cause is
  // logged locally by audited-plan-artifact-store.ts.
  const isEmpty = derivation.kind === 'empty'
  finalizeExecutionRun(
    db,
    {
      runId: args.runId,
      taskId: args.taskId,
      status: 'failed',
      reasonCode: isEmpty ? 'empty_output' : 'spawn_failed',
      toState: 'blocked',
      blockedReasonCode: isEmpty ? 'plan_output_empty' : 'plan_process_failed',
      preBlockState: 'planning',
      blockedPhase: 'execution',
      eventType: 'execution_blocked',
      counters: args.counters
    },
    nowMs
  )
  return { ok: false, kind: derivation.kind }
}
