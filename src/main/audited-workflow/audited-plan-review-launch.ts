// Spawns a Codex plan audit and finalizes its outcome.
//
// Split from audited-plan-review-orchestration.ts so that file stays within its
// line budget without a max-lines suppression. That module owns ADMISSION (is
// this audit legal, and are the bytes the ones the artifact row committed to);
// this one owns EXECUTION (spawn, capture, decide, finalize).
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { getAuditedTaskRepository, getTaskProjection } from './audited-task-service'
import { broadcastAuditedTaskChanged } from './audited-workflow-broadcast'
import { verifyWorktreeForTask } from './audited-worktree-service'
import { sanitizeReviewSummary, type PlanSanitizationContext } from './audited-plan-artifact-store'
import { getPlanReviewRun } from './audited-plan-review-run-repository'
import { finalizePlanReviewRun } from './audited-plan-review-run-finalize'
import {
  parsePlanAuditVerdict,
  readLastMessageFile,
  removeLastMessageFile
} from './audited-plan-audit-verdict'
import { runAuditedCodex, type PlanAuditLaunchContext } from './audited-plan-audit-launcher'
import { writeExecutionOutput } from './audited-execution-output-store'
import { decidePlanReviewOutcome } from './audited-plan-review-outcome'
import { getLastMessagePath, getPlanReviewRunDir } from './audited-plan-review-paths'
import { reconcileCoverage } from './audited-plan-coverage-reconcile'
import { MAX_COVERAGE_NOTE_CHARS } from '../../shared/audited-plan-artifact-types'
import type { CoverageRow } from '../../shared/audited-plan-artifact-types'
import type { AuditedAcceptanceCriterion } from '../../shared/audited-workflow-types'

function broadcastIfProjectable(taskId: string): void {
  const projection = getTaskProjection(taskId)
  if (projection) {
    broadcastAuditedTaskChanged(projection)
  }
}
/**
 * Spawns, then on EVERY terminal outcome: bound+write logs -> re-check ownership
 * -> re-verify the worktree -> read the last-message file -> decide -> finalize.
 */
export async function launchAndFinalizeReview(
  context: PlanAuditLaunchContext,
  sanitizationContext: PlanSanitizationContext,
  /**
   * The authoritative criteria this run was launched against — the SAME array
   * that built the prompt, so what Codex was asked about and what its answer is
   * reconciled against cannot differ.
   */
  acceptanceCriteria: readonly AuditedAcceptanceCriterion[]
): Promise<void> {
  const repo = getAuditedTaskRepository()
  const userDataPath = app.getPath('userData')
  const lastMessagePath = getLastMessagePath(userDataPath, context.runId)

  try {
    mkdirSync(getPlanReviewRunDir(userDataPath, context.runId), { recursive: true })
  } catch (error) {
    console.error('[auditedWorkflow] Creating the plan-review run directory failed:', error)
  }
  // A file left by an earlier attempt must never satisfy this run's read.
  removeLastMessageFile(lastMessagePath)

  const outcome = await runAuditedCodex({ ...context, lastMessagePath })

  const stdout = 'stdout' in outcome ? outcome.stdout : ''
  const stderr = 'stderr' in outcome ? outcome.stderr : ''
  // Diagnostics only — bounded, ANSI-stripped, never projected, never parsed
  // for a verdict.
  const counters = writeExecutionOutput(userDataPath, context.runId, stdout, stderr)

  const current = getPlanReviewRun(repo.getDatabase(), context.runId)
  if (!current || current.status !== 'running') {
    removeLastMessageFile(lastMessagePath)
    broadcastIfProjectable(context.taskId)
    return
  }

  const verified = await verifyWorktreeForTask(context.taskId)

  // The verdict comes from the last-message file on the CLI path, and IN BAND
  // from the no-tools adapter, which spawns nothing and so has no file to write.
  // Both go through the same parser: missing, unreadable, oversized, empty, or
  // malformed all fail closed — never an approved verdict.
  const parsed =
    outcome.kind === 'exit' && outcome.exitCode === 0
      ? outcome.lastMessage !== undefined
        ? parsePlanAuditVerdict(outcome.lastMessage)
        : readAndParseVerdict(lastMessagePath)
      : null

  const decision = decidePlanReviewOutcome({
    outcome,
    driftReasonCode: verified.ok ? null : verified.reasonCode,
    parsed,
    // Reconciled against durable criteria, then redacted with the SAME trusted
    // context as the summary — notes are model-authored text that reaches the
    // renderer, so they get identical treatment.
    coverage:
      parsed !== null && parsed.ok
        ? sanitizeCoverageNotes(
            reconcileCoverage(acceptanceCriteria, parsed.coverage),
            sanitizationContext
          )
        : []
  })

  finalizePlanReviewRun(
    repo.getDatabase(),
    {
      runId: context.runId,
      taskId: context.taskId,
      status: decision.status,
      reasonCode: decision.reasonCode,
      verdict: decision.verdict,
      // Redacted with the trusted context BEFORE storage, so the persisted row
      // — and therefore the projection, the IPC result, and the renderer prop —
      // can never carry an unredacted path or branch name.
      summary:
        decision.summary === null
          ? null
          : sanitizeReviewSummary(decision.summary, sanitizationContext),
      findingCount: decision.findingCount,
      toState: decision.toState,
      blockedReasonCode: decision.blockedReasonCode,
      preBlockState: decision.preBlockState,
      blockedPhase: decision.blockedPhase,
      eventType: decision.eventType,
      coverage: decision.coverage,
      counters: {
        stdoutBytes: counters.stdoutBytes,
        stderrBytes: counters.stderrBytes,
        outputTruncated: counters.outputTruncated,
        exitCode: outcome.kind === 'exit' ? outcome.exitCode : null
      }
    },
    Date.now()
  )

  // The result file has served its purpose; leaving it would let a later,
  // unrelated read observe a verdict that no run owns.
  removeLastMessageFile(lastMessagePath)
  broadcastIfProjectable(context.taskId)
}

/**
 * Redacts and bounds each note before it can reach storage.
 *
 * A note that sanitizes to nothing becomes null rather than an empty string, so
 * the renderer has exactly one representation of "no note". The length cap is
 * applied AFTER redaction — truncating first could leave a half-redacted path.
 */
function sanitizeCoverageNotes(
  rows: readonly CoverageRow[],
  sanitizationContext: PlanSanitizationContext
): CoverageRow[] {
  return rows.map((row) => {
    if (row.note === null) {
      return row
    }
    const redacted = sanitizeReviewSummary(row.note, sanitizationContext)
      .slice(0, MAX_COVERAGE_NOTE_CHARS)
      .trim()
    return { ...row, note: redacted.length > 0 ? redacted : null }
  })
}

function readAndParseVerdict(path: string): ReturnType<typeof parsePlanAuditVerdict> {
  const read = readLastMessageFile(path)
  if (!read.ok) {
    return read
  }
  return parsePlanAuditVerdict(read.text)
}
