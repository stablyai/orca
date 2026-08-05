// Turns a Codex process outcome plus a parsed verdict into finalize arguments.
// Pure decision logic — no I/O, no DB — so the fail-closed rules are testable in
// isolation.
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import type {
  PlanReviewReasonCode,
  PlanReviewRunStatus,
  PlanReviewVerdict
} from '../../shared/audited-plan-artifact-types'
import type { WorktreeReasonCode } from '../../shared/audited-worktree-types'
import type { CodexProcessOutcome } from './audited-codex-process'
import type { PlanAuditVerdictParseResult } from './audited-plan-audit-verdict'
import type { CoverageRow } from '../../shared/audited-plan-artifact-types'

export type PlanReviewOutcomeDecision = {
  status: Exclude<PlanReviewRunStatus, 'running'>
  reasonCode: PlanReviewReasonCode | null
  verdict: PlanReviewVerdict | null
  summary: string | null
  findingCount: number | null
  toState: AuditedTaskState | null
  blockedReasonCode: string | null
  preBlockState: AuditedTaskState | null
  blockedPhase: string | null
  eventType: string
  /**
   * Reconciled coverage (Phase 6). Empty on every path that produced no verdict:
   * a run that timed out, drifted, or was cancelled observed nothing about any
   * criterion, and recording all-uncovered there would assert a judgement that
   * was never made.
   */
  coverage: readonly CoverageRow[]
}

export type DecidePlanReviewOutcomeArgs = {
  outcome: CodexProcessOutcome
  /** Post-run verification. null means it passed. */
  driftReasonCode: WorktreeReasonCode | null
  /** Null when the process never reached a clean exit worth parsing. */
  parsed: PlanAuditVerdictParseResult | null
  /**
   * Coverage already reconciled against the authoritative criteria and
   * sanitized by the caller. Attached ONLY to a verdict-producing outcome.
   */
  coverage: readonly CoverageRow[]
}

function blocked(
  reasonCode: PlanReviewReasonCode,
  blockedReasonCode: string
): PlanReviewOutcomeDecision {
  return {
    status: 'failed',
    reasonCode,
    verdict: null,
    summary: null,
    findingCount: null,
    toState: 'blocked',
    blockedReasonCode,
    preBlockState: 'awaiting_plan_review',
    blockedPhase: 'planReview',
    eventType: 'plan_review_blocked',
    coverage: []
  }
}

/**
 * Drift ALWAYS wins over a clean exit: a review that somehow moved HEAD is
 * blocked rather than allowed to produce a verdict. A read-only audit should
 * never cause drift, so observing it means an assumption has failed and the
 * safe response is to refuse the result.
 *
 * A verdict is produced ONLY on a clean exit with a successfully parsed
 * last-message file. Every other path — including a zero exit with an
 * unreadable or malformed result — fails closed.
 *
 * Coverage follows the verdict exactly: it is attached on the three verdict
 * paths and empty everywhere else, so drift, timeout, and cancellation record no
 * judgement about any criterion.
 */
export function decidePlanReviewOutcome(
  args: DecidePlanReviewOutcomeArgs
): PlanReviewOutcomeDecision {
  const { outcome } = args

  switch (outcome.kind) {
    case 'not_found':
      return blocked('codex_not_found', 'codex_not_found')
    case 'launch_plan_invalid':
      // The safety contract could not be satisfied, so nothing ran. Treated as a
      // process failure rather than a verdict of any kind.
      return blocked('launch_plan_invalid', 'plan_review_process_failed')
    case 'spawn_failed':
      return blocked('spawn_failed', 'plan_review_process_failed')
    case 'timeout':
      return blocked('timeout', 'agent_timeout')
    case 'output_too_large':
      return blocked('output_too_large', 'agent_output_too_large')
    case 'no_tools_failed':
      // A TRANSPORT FAILURE IS NEVER AN APPROVAL. The adapter's reason code is
      // carried through verbatim so the user sees the real condition, but the
      // task blocks exactly as every other non-exit arm blocks it.
      return blocked(outcome.reasonCode, 'plan_review_process_failed')
    case 'cancelled':
      // Cancel is finalized by audited-plan-review-run-cancel.ts. Reaching here
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
        eventType: 'plan_review_cancelled',
        coverage: []
      }
    case 'exit':
      break
  }

  if (args.driftReasonCode !== null) {
    return blocked('unexpected_commit_detected', 'unexpected_commit_detected')
  }

  if (outcome.exitCode !== 0) {
    return blocked('exit_nonzero', 'plan_review_process_failed')
  }

  // Fail-closed: a zero exit with no usable result is NOT an approval.
  if (args.parsed === null || !args.parsed.ok) {
    return blocked('verdict_unparseable', 'plan_review_unparseable')
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
      blockedReasonCode: 'plan_review_process_failed',
      preBlockState: 'awaiting_plan_review',
      blockedPhase: 'planReview',
      eventType: 'plan_review_blocked_verdict',
      // A `blocked` verdict is still a JUDGEMENT Codex made against the criteria,
      // so its matrix is recorded like any other. Only non-verdict outcomes are
      // coverage-free.
      coverage: args.coverage
    }
  }

  if (verdict === 'fixes_requested') {
    return {
      status: 'succeeded',
      reasonCode: null,
      verdict,
      summary,
      findingCount,
      toState: 'plan_fixes_requested',
      blockedReasonCode: null,
      preBlockState: null,
      blockedPhase: null,
      eventType: 'plan_review_fixes_requested',
      // The case coverage matters MOST: a partial matrix is precisely what the
      // operator needs before deciding whether to request a revision.
      coverage: args.coverage
    }
  }

  // `approved` records the verdict but does NOT move the task: reaching
  // ready_to_implement additionally requires the explicit human click in
  // approvePlan. Codex authorizes; it does not advance.
  return {
    status: 'succeeded',
    reasonCode: null,
    verdict,
    summary,
    findingCount,
    toState: null,
    blockedReasonCode: null,
    preBlockState: null,
    blockedPhase: null,
    eventType: 'plan_review_approved_verdict',
    coverage: args.coverage
  }
}
