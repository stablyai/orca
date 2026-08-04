// "Start / Cancel / Retry Execution" — the Phase-2-shaped entry point.
//
// Two DIFFERENT worktree entry points, and the difference is load-bearing:
//  - START uses ensureWorktreeForTask. The task is not blocked there, so that
//    function's blocking failure contract is exactly what is wanted.
//  - RETRY uses verifyWorktreeForTask (read-only). The task is ALREADY blocked
//    with a null worktree_reason_code, where ensureWorktreeForTask could only
//    report `contended` — never the real drift reason — and would mutate a task
//    this path must leave untouched.
import type { ExecutionMode } from '../../shared/audited-execution-types'
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import { getAuditedTaskRepository, getTaskProjection } from './audited-task-service'
import { broadcastAuditedTaskChanged } from './audited-workflow-broadcast'
import { ensureWorktreeForTask, verifyWorktreeForTask } from './audited-worktree-service'
import {
  finalizeExecutionRun,
  getRunningExecutionRun,
  startExecutionRun
} from './audited-execution-run-repository'
import { retryExecutionRun } from './audited-execution-run-retry'
import { cancelExecutionRun } from './audited-execution-run-cancel'
import { recoverInterruptedExecutionRuns } from './audited-execution-run-recovery'
import { resolveNextStepPrompt } from './audited-execution-prompt'
import { launchAndFinalize } from './audited-execution-launch'
import {
  executionFailure,
  freshWorktreeFailure,
  modeStates,
  persistedWorktreeFailure,
  resolveExecutionMode
} from './audited-execution-lane-shapes'
import type { ExecutionCommandResult } from '../../shared/audited-workflow-command-types'

function broadcastIfProjectable(taskId: string): void {
  const projection = getTaskProjection(taskId)
  if (projection) {
    broadcastAuditedTaskChanged(projection)
  }
}

/**
 * Starts one Claude run. Ordering is load-bearing: no model invocation can
 * precede worktree verification, and no process exists that is not already
 * durably recorded.
 */
export async function startExecution(taskId: string): Promise<ExecutionCommandResult> {
  const repo = getAuditedTaskRepository()
  const task = repo.getTask(taskId)
  if (!task || task.triageDecision === null) {
    return executionFailure('illegal_transition')
  }

  const mode: ExecutionMode = resolveExecutionMode(task.state, task.triageDecision)
  const { preLaunchState, activeRunState } = modeStates(mode)
  if (task.state !== preLaunchState) {
    return executionFailure('illegal_transition')
  }

  // Step 1 — hard precondition. Any failure returns a worktree result and
  // spawns nothing.
  const worktree = await ensureWorktreeForTask(taskId)
  if (!worktree.ok) {
    broadcastIfProjectable(taskId)
    if ('contended' in worktree) {
      return executionFailure('lock_contended')
    }
    // ensureWorktreeForTask BLOCKED the task and persisted this reason, so the
    // projection carries it durably — persisted: true, not a fresh read.
    return persistedWorktreeFailure(worktree.reasonCode)
  }

  // Step 2 — RELOAD. `task` was read before provisioning, which may have just
  // created the worktree and written its identity (or a concurrent writer may
  // have moved the task entirely). Launching with the pre-ensure snapshot would
  // use a stale — possibly null — worktree path as the process cwd.
  const refreshed = repo.getTask(taskId)
  if (!refreshed || refreshed.state !== preLaunchState) {
    return executionFailure('illegal_transition')
  }
  // A verified worktree identity must be COMPLETE before anything is spawned.
  // ensureWorktreeForTask returning ok is not by itself proof the durable row
  // carries the identity this launch needs.
  if (
    !refreshed.worktreePath ||
    !refreshed.branchName ||
    !refreshed.worktreeProvenance ||
    refreshed.worktreeReasonCode !== null
  ) {
    return executionFailure('worktree_not_verified')
  }
  const worktreePath = refreshed.worktreePath

  // Step 3 — prompt from durable state, never from the renderer.
  const prompt = resolveNextStepPrompt(repo.getDatabase(), taskId)
  if (prompt === null) {
    return executionFailure('prompt_unavailable')
  }

  // Step 4 — CAS before spawn. A duplicate click loses the race here.
  const nowMs = Date.now()
  const started = startExecutionRun(
    repo.getDatabase(),
    { taskId, mode, preLaunchState, activeRunState, worktreeVerifiedAtMs: nowMs },
    nowMs
  )
  if (!started.ok) {
    return executionFailure(
      started.reasonCode === 'lock_contended' ? 'lock_contended' : 'illegal_transition'
    )
  }
  broadcastIfProjectable(taskId)

  await launchAndFinalize({
    runId: started.runId,
    taskId,
    mode,
    activeRunState,
    worktreePath,
    prompt
  })
  return { ok: true }
}

/**
 * Retries an execution-blocked task.
 *
 * On preflight failure NOTHING happens: the existing block is left exactly as it
 * is, no execution row is created, no transition is written, and the fresh
 * reason is returned with persisted:false. It is display-only — it is not
 * admissible to worktree recovery.
 */
export async function retryExecution(taskId: string): Promise<ExecutionCommandResult> {
  const repo = getAuditedTaskRepository()
  const task = repo.getTask(taskId)
  if (!task || task.state !== 'blocked') {
    return executionFailure('illegal_transition')
  }

  // Read-only, while the task stays blocked. NOT ensureWorktreeForTask.
  // Nothing is written, so this reason is fresh — persisted: false.
  const verified = await verifyWorktreeForTask(taskId)
  if (!verified.ok) {
    return freshWorktreeFailure(verified.reasonCode)
  }

  const nowMs = Date.now()
  const retried = retryExecutionRun(
    repo.getDatabase(),
    { taskId, worktreeVerifiedAtMs: nowMs },
    nowMs
  )
  if (!retried.ok) {
    return executionFailure(
      retried.reasonCode === 'lock_contended' ? 'lock_contended' : 'illegal_transition'
    )
  }
  broadcastIfProjectable(taskId)

  // The identity comes from the row the retry transaction just re-read, but it
  // must still be complete — a task can be unblocked while carrying no verified
  // worktree, and that must never reach a spawn.
  if (!retried.task.worktreePath || !retried.task.branchName || !retried.task.worktreeProvenance) {
    await finalizeUnlaunchable(retried.runId, taskId, retried.task.state, 'worktree_not_verified')
    return executionFailure('worktree_not_verified')
  }

  const prompt = resolveNextStepPrompt(repo.getDatabase(), taskId)
  if (prompt === null) {
    // The run row exists, so it must be finalized rather than abandoned.
    await finalizeUnlaunchable(retried.runId, taskId, retried.task.state, 'prompt_unavailable')
    return executionFailure('prompt_unavailable')
  }

  await launchAndFinalize({
    runId: retried.runId,
    taskId,
    mode: retried.mode,
    activeRunState: retried.task.state,
    worktreePath: retried.task.worktreePath,
    prompt
  })
  return { ok: true }
}

/**
 * Cancels a running execution. Kill precedes the transaction — committing while
 * the process still runs would leave a live process with no `running` row.
 * Runs NO Git command.
 */
export async function cancelExecution(taskId: string): Promise<ExecutionCommandResult> {
  const repo = getAuditedTaskRepository()
  const running = getRunningExecutionRun(repo.getDatabase(), taskId)
  if (!running) {
    return executionFailure('lock_contended')
  }

  const { killClaudeProcess, markCancelRequested } = await import('./audited-claude-process')
  markCancelRequested(running.id)
  await killClaudeProcess(running.id)

  const result = cancelExecutionRun(repo.getDatabase(), { runId: running.id, taskId }, Date.now())
  broadcastIfProjectable(taskId)
  if (!result.ok) {
    return executionFailure(
      result.reasonCode === 'illegal_transition' ? 'illegal_transition' : 'lock_contended'
    )
  }
  return { ok: true }
}

/**
 * Fail-safe by design: this runs during IPC handler registration, and an
 * exception here would abort registration and leave the app with no handlers at
 * all. A failed sweep only means stale `running` rows persist until the next
 * start, which the CAS guards already tolerate.
 */
export function recoverInterruptedExecutionsOnStartup(): void {
  try {
    const repo = getAuditedTaskRepository()
    const recovered = recoverInterruptedExecutionRuns(repo.getDatabase(), Date.now())
    for (const { taskId } of recovered) {
      broadcastIfProjectable(taskId)
    }
  } catch (error) {
    console.error('[auditedWorkflow] Interrupted-execution recovery failed:', error)
  }
}

/**
 * Blocks a run that was durably started but can never launch. The row already
 * exists, so abandoning it would leave a `running` row with no process — which
 * startup recovery would later reclassify as `interrupted`, a less truthful
 * outcome than the reason we actually know.
 */
async function finalizeUnlaunchable(
  runId: string,
  taskId: string,
  activeRunState: AuditedTaskState,
  reasonCode: 'prompt_unavailable' | 'worktree_not_verified'
): Promise<void> {
  const repo = getAuditedTaskRepository()
  finalizeExecutionRun(
    repo.getDatabase(),
    {
      runId,
      taskId,
      status: 'failed',
      reasonCode,
      toState: 'blocked',
      blockedReasonCode:
        activeRunState === 'planning' ? 'plan_process_failed' : 'implement_process_failed',
      preBlockState: activeRunState,
      blockedPhase: 'execution',
      eventType: 'execution_blocked',
      counters: { stdoutBytes: 0, stderrBytes: 0, outputTruncated: false, exitCode: null }
    },
    Date.now()
  )
  broadcastIfProjectable(taskId)
}
