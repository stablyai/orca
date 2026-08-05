// Turns a Codex process outcome plus a parsed verdict into finalize arguments
// (Phase 7). Pure decision logic — no I/O, no DB — so the fail-closed rules are
// testable in isolation, exactly like decidePlanReviewOutcome.
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import type {
  CodeAuditReasonCode,
  CodeAuditRunStatus,
  CodeAuditVerdict
} from '../../shared/audited-code-audit-types'
import type { WorktreeReasonCode } from '../../shared/audited-worktree-types'
import type { CodexProcessOutcome } from './audited-codex-process'
import type { PlanAuditVerdictParseResult } from './audited-plan-audit-verdict'

export type CodeAuditOutcomeDecision = {
  status: Exclude<CodeAuditRunStatus, 'running'>
  reasonCode: CodeAuditReasonCode | null
  verdict: CodeAuditVerdict | null
  summary: string | null
  findingCount: number | null
  toState: AuditedTaskState | null
  blockedReasonCode: string | null
  preBlockState: AuditedTaskState | null
  blockedPhase: string | null
  eventType: string
}

export type DecideCodeAuditOutcomeArgs = {
  outcome: CodexProcessOutcome
  /** Post-run verification. null means it passed. */
  driftReasonCode: WorktreeReasonCode | null
  /** Null when the process never reached a clean exit worth parsing. */
  parsed: PlanAuditVerdictParseResult | null
  /** The task's completed fix rounds, for the round cap on fixes_requested. */
  fixRound: number
  /** The cap itself, injected so the rule is testable without a constant import. */
  maxFixRounds: number
}

function blocked(
  reasonCode: CodeAuditReasonCode,
  blockedReasonCode: string
): CodeAuditOutcomeDecision {
  return {
    status: 'failed',
    reasonCode,
    verdict: null,
    summary: null,
    findingCount: null,
    toState: 'blocked',
    blockedReasonCode,
    preBlockState: 'awaiting_code_audit',
    blockedPhase: 'codeAudit',
    eventType: 'code_audit_blocked'
  }
}

/**
 * Drift ALWAYS wins over a clean exit: an audit that somehow moved HEAD is
 * blocked rather than allowed to produce a verdict. A read-only audit should
 * never cause drift, so observing it means an assumption has failed and the safe
 * response is to refuse the result.
 *
 * A verdict is produced ONLY on a clean exit with a successfully parsed
 * last-message file. Every other path — including a zero exit with an unreadable
 * or malformed result — fails closed.
 *
 * THE ROUND CAP IS APPLIED HERE, not at admission: a round-3 candidate must stay
 * auditable and approvable. What the cap forbids is entering ANOTHER fix round,
 * so a `fixes_requested` verdict at the cap blocks instead of looping forever.
 */
export function decideCodeAuditOutcome(args: DecideCodeAuditOutcomeArgs): CodeAuditOutcomeDecision {
  const { outcome } = args

  switch (outcome.kind) {
    case 'not_found':
      return blocked('codex_not_found', 'codex_not_found')
    case 'launch_plan_invalid':
      // The safety contract could not be satisfied, so nothing ran.
      return blocked('launch_plan_invalid', 'code_audit_process_failed')
    case 'spawn_failed':
      return blocked('spawn_failed', 'code_audit_process_failed')
    case 'timeout':
      return blocked('timeout', 'agent_timeout')
    case 'output_too_large':
      return blocked('output_too_large', 'agent_output_too_large')
    case 'no_tools_failed':
      // A TRANSPORT FAILURE IS NEVER AN APPROVAL. The adapter's reason code is
      // carried through verbatim so the user sees "rate limited" rather than a
      // generic process failure, but the task is blocked exactly as every other
      // non-exit arm blocks it.
      return blocked(outcome.reasonCode, 'code_audit_process_failed')
    case 'cancelled':
      // Cancel is finalized by audited-code-audit-run-cancel.ts. Reaching here
      // means the process ended without that transaction having run; record it
      // truthfully without moving the task.
      return {
        status: 'cancelled',
        reasonCode: 'cancelled_by_user',
        verdict: null,
        summary: null,
        findingCount: null,
        toState: null,
        blockedReasonCode: null,
        preBlockState: null,
        blockedPhase: null,
        eventType: 'code_audit_cancelled'
      }
    case 'exit':
      break
  }

  if (args.driftReasonCode !== null) {
    return blocked('unexpected_commit_detected', 'unexpected_commit_detected')
  }

  if (outcome.exitCode !== 0) {
    return blocked('exit_nonzero', 'code_audit_process_failed')
  }

  // Fail-closed: a zero exit with no usable result is NOT an approval.
  if (args.parsed === null || !args.parsed.ok) {
    return blocked('verdict_unparseable', 'code_audit_unparseable')
  }

  const { verdict, summary, findingCount } = args.parsed

  if (verdict === 'blocked') {
    return {
      status: 'succeeded',
      reasonCode: null,
      verdict,
      summary,
      findingCount,
      toState: 'blocked',
      blockedReasonCode: 'code_audit_process_failed',
      preBlockState: 'awaiting_code_audit',
      blockedPhase: 'codeAudit',
      eventType: 'code_audit_blocked_verdict'
    }
  }

  if (verdict === 'fixes_requested') {
    // At the cap there is no legal next fix, so parking the task in
    // code_fixes_requested would strand it with a Request Fix button that must
    // always refuse. Blocking names the real reason instead.
    if (args.fixRound >= args.maxFixRounds) {
      return {
        status: 'succeeded',
        reasonCode: 'round_limit_reached',
        verdict,
        summary,
        findingCount,
        toState: 'blocked',
        blockedReasonCode: 'code_audit_round_limit',
        preBlockState: 'awaiting_code_audit',
        blockedPhase: 'codeAudit',
        eventType: 'code_audit_round_limit'
      }
    }
    return {
      status: 'succeeded',
      reasonCode: null,
      verdict,
      summary,
      findingCount,
      toState: 'code_fixes_requested',
      blockedReasonCode: null,
      preBlockState: null,
      blockedPhase: null,
      eventType: 'code_audit_fixes_requested'
    }
  }

  // `approved` DOES move the task, unlike the plan lane. codeAuditApprove is
  // declared with actor `codex` and target awaiting_human_approval: the human
  // gate in this lane is the later commit authorization, not this transition.
  return {
    status: 'succeeded',
    reasonCode: null,
    verdict,
    summary,
    findingCount,
    toState: 'awaiting_human_approval',
    blockedReasonCode: null,
    preBlockState: null,
    blockedPhase: null,
    eventType: 'code_audit_approved_verdict'
  }
}
