// Spawns a Claude execution and finalizes its outcome.
//
// Split from audited-execution-orchestration.ts so that file stays within its
// line budget without a max-lines suppression, mirroring the plan-review and
// code-audit lanes. That module owns ADMISSION (is this run legal, is the
// worktree verified, is there a prompt); this one owns EXECUTION (spawn,
// capture, decide, route to the mode-specific completion, finalize).
//
// THE TWO COMPLETION HOOKS. A successful plan run and a successful implement or
// fix run do not simply move the task: each must first produce a durable artifact
// (a plan artifact, or a candidate tree), and the task advances only inside that
// artifact's guarded transaction. Both hooks finalize the run in every branch, so
// the plain finalizeExecutionRun below runs only for outcomes that produce
// neither.
import { app } from 'electron'
import { getAuditedTaskRepository, getTaskProjection } from './audited-task-service'
import { broadcastAuditedTaskChanged } from './audited-workflow-broadcast'
import { verifyWorktreeForTask } from './audited-worktree-service'
import { finalizeExecutionRun, getExecutionRun } from './audited-execution-run-repository'
import { decideExecutionOutcome } from './audited-execution-outcome'
import { hasMeaningfulOutput, writeExecutionOutput } from './audited-execution-output-store'
import { runAuditedClaude, type ExecutionLaunchContext } from './audited-execution-launcher'
import { completePlanRun } from './audited-plan-run-completion'
import { completeImplementRun } from './audited-implement-run-completion'

function broadcastIfProjectable(taskId: string): void {
  const projection = getTaskProjection(taskId)
  if (projection) {
    broadcastAuditedTaskChanged(projection)
  }
}

/**
 * Spawns, then on EVERY terminal outcome, in this order: bound+write logs ->
 * re-verify the worktree -> apply the mode-specific success rule -> CAS-finalize
 * -> broadcast.
 */
export async function launchAndFinalize(context: ExecutionLaunchContext): Promise<void> {
  const repo = getAuditedTaskRepository()
  const outcome = await runAuditedClaude(context)

  const stdout = 'stdout' in outcome ? outcome.stdout : ''
  const stderr = 'stderr' in outcome ? outcome.stderr : ''
  const counters = writeExecutionOutput(app.getPath('userData'), context.runId, stdout, stderr)

  // A cancel that already finalized this run must not be overwritten.
  const current = getExecutionRun(repo.getDatabase(), context.runId)
  if (!current || current.status !== 'running') {
    broadcastIfProjectable(context.taskId)
    return
  }

  // Verification BEFORE the success decision, so drift always wins.
  const verified = await verifyWorktreeForTask(context.taskId)
  const decision = decideExecutionOutcome({
    mode: context.mode,
    activeRunState: context.activeRunState,
    outcome,
    driftReasonCode: verified.ok ? null : verified.reasonCode,
    hasStdout: hasMeaningfulOutput(stdout)
  })

  // Phase 7: symmetrically, a SUCCESSFUL implement or fix run must first produce
  // a durable CANDIDATE — the tree identity the code audit will be bound to — and
  // the task advances only inside that candidate's guarded transaction.
  // completeImplementRun finalizes the run in every branch.
  if (decision.status === 'succeeded' && decision.toState === 'awaiting_code_audit') {
    const task = repo.getTask(context.taskId)
    if (task) {
      await completeImplementRun(
        repo.getDatabase(),
        {
          runId: context.runId,
          taskId: context.taskId,
          task,
          userDataPath: app.getPath('userData'),
          activeRunState: context.activeRunState,
          counters: {
            stdoutBytes: counters.stdoutBytes,
            stderrBytes: counters.stderrBytes,
            outputTruncated: counters.outputTruncated,
            exitCode: outcome.kind === 'exit' ? outcome.exitCode : null
          }
        },
        Date.now()
      )
      broadcastIfProjectable(context.taskId)
      return
    }
  }

  // Phase 5: a SUCCESSFUL plan run does not simply move the task — it must first
  // produce a durable artifact, and the task advances only inside that
  // artifact's guarded transaction. completePlanRun finalizes the run in every
  // branch, so nothing below runs for this path.
  if (decision.status === 'succeeded' && decision.toState === 'awaiting_plan_review') {
    const task = repo.getTask(context.taskId)
    if (task) {
      completePlanRun(
        repo.getDatabase(),
        {
          runId: context.runId,
          taskId: context.taskId,
          task,
          rawPlanText: stdout,
          userDataPath: app.getPath('userData'),
          counters: {
            stdoutBytes: counters.stdoutBytes,
            stderrBytes: counters.stderrBytes,
            outputTruncated: counters.outputTruncated,
            exitCode: outcome.kind === 'exit' ? outcome.exitCode : null
          }
        },
        Date.now()
      )
      broadcastIfProjectable(context.taskId)
      return
    }
  }

  finalizeExecutionRun(
    repo.getDatabase(),
    {
      runId: context.runId,
      taskId: context.taskId,
      status: decision.status,
      reasonCode: decision.reasonCode,
      toState: decision.toState,
      blockedReasonCode: decision.blockedReasonCode,
      preBlockState: decision.preBlockState,
      blockedPhase: decision.blockedPhase,
      eventType: decision.eventType,
      counters: {
        stdoutBytes: counters.stdoutBytes,
        stderrBytes: counters.stderrBytes,
        outputTruncated: counters.outputTruncated,
        exitCode: outcome.kind === 'exit' ? outcome.exitCode : null
      }
    },
    Date.now()
  )
  broadcastIfProjectable(context.taskId)
}
