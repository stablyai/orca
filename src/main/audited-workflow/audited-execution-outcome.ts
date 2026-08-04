// Turns a process outcome plus a post-run worktree verification into the
// finalize arguments. Pure decision logic — no I/O, no DB — so the mode-specific
// success rules are testable in isolation.
import type { AuditedTaskState, BlockReasonCode } from '../../shared/audited-workflow-types'
import type {
  ExecutionMode,
  ExecutionReasonCode,
  ExecutionRunStatus
} from '../../shared/audited-execution-types'
import type { WorktreeReasonCode } from '../../shared/audited-worktree-types'
import type { ClaudeProcessOutcome } from './audited-claude-process'

export type ExecutionOutcomeDecision = {
  status: Exclude<ExecutionRunStatus, 'running'>
  reasonCode: ExecutionReasonCode | null
  toState: AuditedTaskState | null
  blockedReasonCode: string | null
  preBlockState: AuditedTaskState | null
  blockedPhase: string | null
  eventType: string
}

export type DecideOutcomeArgs = {
  mode: ExecutionMode
  activeRunState: AuditedTaskState
  outcome: ClaudeProcessOutcome
  /** Post-run verification. null means it passed. */
  driftReasonCode: WorktreeReasonCode | null
  /** Whether stdout had non-whitespace content, computed by the caller. */
  hasStdout: boolean
}

function blocked(
  reasonCode: ExecutionReasonCode,
  blockedReasonCode: string,
  activeRunState: AuditedTaskState,
  status: Exclude<ExecutionRunStatus, 'running'> = 'failed'
): ExecutionOutcomeDecision {
  return {
    status,
    reasonCode,
    toState: 'blocked',
    blockedReasonCode,
    preBlockState: activeRunState,
    blockedPhase: 'execution',
    eventType: 'execution_blocked'
  }
}

/**
 * Drift ALWAYS wins over a clean exit code: a direct run that exits 0 but moved
 * HEAD is blocked `unexpected_commit_detected`, never advanced to
 * awaiting_code_audit. This is the authoritative Git boundary — it is
 * state-based, so it catches a commit made by ANY route, including one the
 * launch denylist provably cannot stop.
 *
 * Empty output is mode-dependent because the two modes produce different
 * artifacts: plan's only product is the stdout text, while direct's product is
 * the worktree diff and its stdout is incidental commentary.
 */
/**
 * The lane-specific process-failure reason, so a blocked fix never reports itself
 * as a failed implement (and vice versa). Phase 7 gives `fix_process_failed` —
 * declared since Phase 1 — its first producer.
 */
function processFailedReason(mode: ExecutionMode): BlockReasonCode {
  if (mode === 'plan') {
    return 'plan_process_failed'
  }
  return mode === 'fix' ? 'fix_process_failed' : 'implement_process_failed'
}

export function decideExecutionOutcome(args: DecideOutcomeArgs): ExecutionOutcomeDecision {
  const { activeRunState, mode, outcome } = args

  switch (outcome.kind) {
    case 'not_found':
      return blocked('claude_not_found', 'claude_not_found', activeRunState)
    case 'spawn_failed':
      return blocked('spawn_failed', processFailedReason(mode), activeRunState)
    case 'timeout':
      return blocked('timeout', 'agent_timeout', activeRunState)
    case 'output_too_large':
      return blocked('output_too_large', 'agent_output_too_large', activeRunState)
    case 'cancelled':
      // Cancel is finalized by audited-execution-run-cancel.ts, which restores
      // the pre-launch state. Reaching here means the process ended without that
      // transaction having run; record it truthfully without moving the task.
      return {
        status: 'cancelled',
        reasonCode: 'cancelled_by_user',
        toState: null,
        blockedReasonCode: null,
        preBlockState: null,
        blockedPhase: null,
        eventType: 'execution_cancelled'
      }
    case 'exit':
      break
  }

  // Verification runs BEFORE the success decision, so drift always wins.
  if (args.driftReasonCode !== null) {
    return blocked(
      'unexpected_commit_detected',
      'unexpected_commit_detected',
      activeRunState,
      'blocked'
    )
  }

  if (outcome.exitCode !== 0) {
    return blocked('exit_nonzero', processFailedReason(mode), activeRunState)
  }

  // plan mode is read-only; blank stdout means it produced nothing at all, and
  // advancing to awaiting_plan_review with no plan to review would be false.
  if (mode === 'plan' && !args.hasStdout) {
    return blocked('empty_output', 'plan_output_empty', activeRunState)
  }

  return {
    status: 'succeeded',
    reasonCode: null,
    toState: mode === 'plan' ? 'awaiting_plan_review' : 'awaiting_code_audit',
    blockedReasonCode: null,
    preBlockState: null,
    blockedPhase: null,
    eventType: mode === 'plan' ? 'plan_complete' : 'implement_complete'
  }
}
