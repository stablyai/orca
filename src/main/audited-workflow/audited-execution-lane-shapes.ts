// The execution lane's result shapes and mode resolution.
//
// Split from audited-execution-orchestration.ts to keep that file within its line
// budget without a max-lines suppression. Pure — no DB, no I/O — so the
// mode/state mapping is testable on its own.
import type { ExecutionMode } from '../../shared/audited-execution-types'
import type { WorktreeReasonCode } from '../../shared/audited-worktree-types'
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import type { ExecutionCommandResult } from '../../shared/audited-workflow-command-types'

export function executionFailure(
  reasonCode: Parameters<typeof executionFailureShape>[0]
): ExecutionCommandResult {
  return executionFailureShape(reasonCode)
}

function executionFailureShape(
  reasonCode:
    | 'illegal_transition'
    | 'lock_contended'
    | 'prompt_unavailable'
    | 'worktree_not_verified'
): ExecutionCommandResult {
  return { ok: false, kind: 'execution', reasonCode }
}

/**
 * A PERSISTED worktree block: ensureWorktreeForTask already blocked the task and
 * wrote worktree_reason_code, so the projection carries this reason durably.
 */
export function persistedWorktreeFailure(reasonCode: WorktreeReasonCode): ExecutionCommandResult {
  return { ok: false, kind: 'worktree', reasonCode, persisted: true }
}

/**
 * A FRESH read-only verification result — never a stored column. Reserved for
 * retryExecution's verifyWorktreeForTask preflight, which writes nothing.
 */
export function freshWorktreeFailure(reasonCode: WorktreeReasonCode): ExecutionCommandResult {
  return { ok: false, kind: 'worktree', reasonCode, persisted: false }
}

export function modeStates(mode: ExecutionMode): {
  preLaunchState: AuditedTaskState
  activeRunState: AuditedTaskState
} {
  if (mode === 'plan') {
    return { preLaunchState: 'planning', activeRunState: 'planning' }
  }
  // Phase 7. A fix RE-ENTERS awaiting_code_audit — a state the task already
  // passed through — which is exactly why the code-audit lane must refuse to
  // admit an audit while an execution run is live.
  if (mode === 'fix') {
    return { preLaunchState: 'code_fixes_requested', activeRunState: 'awaiting_code_audit' }
  }
  return { preLaunchState: 'ready_to_implement', activeRunState: 'implementing' }
}

/**
 * The mode a start request implies, from durable state alone.
 *
 * A task resting in code_fixes_requested is starting a FIX, regardless of its
 * original triage decision — the triage decision chose plan-vs-direct once, at
 * the beginning, and cannot describe a later fix round.
 */
export function resolveExecutionMode(
  state: AuditedTaskState,
  triageDecision: string
): ExecutionMode {
  if (state === 'code_fixes_requested') {
    return 'fix'
  }
  return triageDecision === 'plan' ? 'plan' : 'direct'
}
