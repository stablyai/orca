// "Run / Cancel / Retry Codex plan audit", plus the two human decisions.
//
// Ordering is load-bearing and mirrors startExecution: nothing is spawned until
// the worktree is verified AND the artifact is proven current inside the same
// transaction that creates the run row. A verdict can therefore only ever be
// produced for a plan that was current at admission.
import { app } from 'electron'
import { homedir } from 'node:os'
import type {
  PlanApprovalReasonCode,
  PlanReviewReasonCode,
  PlanRevisionReasonCode
} from '../../shared/audited-plan-artifact-types'
import { getAuditedTaskRepository, getTaskProjection } from './audited-task-service'
import { broadcastAuditedTaskChanged } from './audited-workflow-broadcast'
import { verifyWorktreeForTask } from './audited-worktree-service'
import { getCurrentPlanArtifact } from './audited-plan-artifact-repository'
import {
  readVerifiedPlanArtifact,
  type PlanSanitizationContext
} from './audited-plan-artifact-store'
import { getRunningPlanReviewRun, startPlanReviewRun } from './audited-plan-review-run-repository'
import { cancelPlanReviewRun } from './audited-plan-review-run-cancel'
import { recoverInterruptedPlanReviewRuns } from './audited-plan-review-run-recovery'
import { approvePlan, requestPlanRevision } from './audited-plan-review-approval'
import { buildPlanAuditPrompt } from './audited-plan-audit-prompt'
import { resolveAcceptanceCriteria } from './audited-plan-audit-criteria'
import { resolveAuditedCodexProvider } from './audited-codex-provider-settings'
import { removeLastMessageFile } from './audited-plan-audit-verdict'
import { startExecution } from './audited-execution-orchestration'
import { validateRetryTransition } from './audited-workflow-state-machine'
import { launchAndFinalizeReview } from './audited-plan-review-launch'
import { getLastMessagePath } from './audited-plan-review-paths'
import type { ExecutionCommandResult } from '../../shared/audited-workflow-command-types'

export type PlanReviewCommandResult =
  | { ok: true }
  | { ok: false; kind: 'planReview'; reasonCode: PlanReviewReasonCode }
  | { ok: false; kind: 'worktree'; reasonCode: string }

export type PlanApprovalCommandResult =
  | { ok: true }
  | { ok: false; reasonCode: PlanApprovalReasonCode }

export type PlanRevisionCommandResult =
  | { ok: true }
  | { ok: false; reasonCode: PlanRevisionReasonCode }

function broadcastIfProjectable(taskId: string): void {
  const projection = getTaskProjection(taskId)
  if (projection) {
    broadcastAuditedTaskChanged(projection)
  }
}

function reviewFailure(reasonCode: PlanReviewReasonCode): PlanReviewCommandResult {
  return { ok: false, kind: 'planReview', reasonCode }
}

// Re-exported so existing importers keep one entry point for the lane.
export { getLastMessagePath, getPlanReviewRunDir } from './audited-plan-review-paths'

/**
 * Starts one Codex plan audit.
 *
 * The artifact body is read from disk BEFORE the transaction (a file read cannot
 * be inside one), so startPlanReviewRun re-checks currency at insert time. That
 * re-check is what guarantees an obsolete plan never reaches a spawn.
 */
export async function startPlanAudit(taskId: string): Promise<PlanReviewCommandResult> {
  const repo = getAuditedTaskRepository()
  const db = repo.getDatabase()

  const snapshot = repo.getTask(taskId)
  if (!snapshot || snapshot.state !== 'awaiting_plan_review') {
    return reviewFailure('illegal_transition')
  }

  // Read-only verification before any model invocation, matching startExecution.
  // NOTE this AWAITS, and verification itself reloads durable state — so the
  // snapshot above is stale from here on and must not supply a launch input.
  const verified = await verifyWorktreeForTask(taskId)
  if (!verified.ok) {
    return { ok: false, kind: 'worktree', reasonCode: verified.reasonCode }
  }

  // RELOAD. Everything below comes from THIS row, never the pre-verification
  // snapshot. A concurrent writer can change the worktree identity in the gap,
  // and launching with the stale path would spawn Codex against a directory
  // that is not the one just verified — the exact race this reload closes.
  // (Mirrors startExecution's step 2 for the same reason.)
  const task = repo.getTask(taskId)
  if (!task || task.state !== 'awaiting_plan_review') {
    return reviewFailure('illegal_transition')
  }
  // A verified worktree identity must be COMPLETE before anything is spawned:
  // ensure/verify returning ok is not by itself proof the durable row carries
  // the identity this launch needs.
  if (
    !task.worktreePath ||
    !task.branchName ||
    !task.worktreeProvenance ||
    task.worktreeVerifiedAt === null ||
    task.worktreeReasonCode !== null
  ) {
    return reviewFailure('worktree_not_verified')
  }
  // The identity must also still be the one verification just approved.
  if (task.worktreePath !== snapshot.worktreePath || task.branchName !== snapshot.branchName) {
    return reviewFailure('worktree_identity_changed')
  }
  // Captured for the CAS to re-check. Deliberately NOT used as the spawn cwd —
  // the artifact and criteria reads below reopen the same window, so only the
  // path startPlanReviewRun reads inside its transaction is authoritative.
  const expectedWorktreeIdentity = {
    worktreePath: task.worktreePath,
    branchName: task.branchName,
    worktreeProvenance: task.worktreeProvenance,
    worktreeVerifiedAt: task.worktreeVerifiedAt,
    worktreeReasonCode: null
  } as const

  // Deliberately NO planRound check: the round cap binds when starting a
  // revision, never here. A round-3 plan must remain auditable. Read AFTER the
  // reload so the artifact pointer matches the refreshed row.
  const artifact = getCurrentPlanArtifact(db, taskId)
  if (!artifact || artifact.id !== task.currentPlanArtifactId) {
    return reviewFailure('artifact_unavailable')
  }

  // THE REVIEWED BYTES ARE BOUND TO THE ARTIFACT HASH.
  // Codex must never audit anything other than the exact text the artifact row
  // committed to. A file edited after derivation would otherwise be reviewed
  // while every hash-based guard downstream still agreed, so an `approved`
  // verdict could authorize implementing a plan no one reviewed.
  const verifiedArtifact = readVerifiedPlanArtifact(
    app.getPath('userData'),
    artifact.id,
    artifact.contentSha256
  )
  if (!verifiedArtifact.ok) {
    return reviewFailure(verifiedArtifact.reasonCode)
  }
  if (!/\S/.test(verifiedArtifact.text)) {
    return reviewFailure('artifact_unavailable')
  }
  // Everything below uses THIS in-memory string. A second read after
  // verification would reopen exactly the window just closed.
  const planText = verifiedArtifact.text

  // The criteria Codex judges against, from the authoritative succeeded triage
  // run. Resolved BEFORE the run row is inserted so a failure leaves the task
  // and its transition history completely untouched.
  const criteria = resolveAcceptanceCriteria(db, taskId)
  if (!criteria.ok) {
    return reviewFailure(criteria.reasonCode)
  }

  // PRE-ADMISSION provider resolution. A configuration problem never reached
  // Codex, so it must not create a run row, write task state, append a
  // transition, or block the task — the same guarantee as the criteria check
  // directly above. Selection is derived from the encrypted key record alone;
  // the `auditedCodexProvider` settings field is deliberately not read, so a
  // stale or hand-planted value is inert.
  const providerResolution = resolveAuditedCodexProvider()
  if (!providerResolution.ok) {
    return reviewFailure(providerResolution.reasonCode)
  }

  const nowMs = Date.now()
  const started = startPlanReviewRun(
    db,
    {
      taskId,
      artifactId: artifact.id,
      artifactSha256: artifact.contentSha256,
      round: artifact.round,
      worktreeVerifiedAtMs: nowMs,
      expectedWorktreeIdentity,
      auditMode: providerResolution.mode
    },
    nowMs
  )
  if (!started.ok) {
    return reviewFailure(started.reasonCode)
  }
  broadcastIfProjectable(taskId)

  await launchAndFinalizeReview(
    {
      runId: started.runId,
      taskId,
      // The CAS-CONFIRMED path: read inside the admission transaction and proven
      // there to match the verified identity. Using anything captured earlier
      // would reintroduce the stale-cwd race this closes.
      worktreePath: started.worktreePath,
      mode: providerResolution.mode,
      // The plan lane's bundle carries the SANITIZED plan text and no diff: the
      // artifact under review is the plan itself, not a change set.
      bundle:
        providerResolution.mode === 'byesu_no_tools'
          ? {
              title: task.title,
              description: parseDescription(task.specJson),
              acceptanceCriteria: criteria.criteria,
              planText,
              diffStat: '(not applicable — this is a plan audit)',
              diff: '',
              files: [],
              redactionContext: buildSanitizationContext(task)
            }
          : undefined,
      prompt: buildPlanAuditPrompt({
        title: task.title,
        description: parseDescription(task.specJson),
        acceptanceCriteria: criteria.criteria,
        // The VERIFIED in-memory text, never a re-read.
        planText
      })
    },
    // The Codex summary is model-authored free text that reaches the renderer,
    // so it is redacted against the SAME trusted identity values the plan body
    // was. Every value comes from the REFRESHED durable task row — never from
    // renderer input, which supplies only a taskId.
    buildSanitizationContext(task),
    // The SAME criteria array the prompt was built from, so the question Codex
    // was asked and the set its answer is reconciled against are identical.
    criteria.criteria
  )
  return { ok: true }
}

/**
 * The trusted redaction context, assembled entirely from main-owned state.
 *
 * Codex is told the worktree is its working root and can read the repository, so
 * its summary can quote an absolute path or the audited branch name verbatim.
 * Without these literals the generic path patterns alone would miss, for
 * example, a repo checked out somewhere unusual.
 */
function buildSanitizationContext(task: {
  worktreePath: string | null
  sourceRepoPath: string
  sourceRepoCommonDir: string | null
  branchName: string | null
}): PlanSanitizationContext {
  return {
    worktreePath: task.worktreePath,
    sourceRepoPath: task.sourceRepoPath,
    sourceRepoCommonDir: task.sourceRepoCommonDir,
    branchName: task.branchName,
    userDataPath: app.getPath('userData'),
    homePath: homedir()
  }
}

/**
 * Retries an audit for a task blocked by a retryable review failure. Re-runs the
 * FULL admission path — a retry is not exempt from the currency re-check, since
 * the plan may have been revised while the task sat blocked.
 */
export async function retryPlanAudit(taskId: string): Promise<PlanReviewCommandResult> {
  const repo = getAuditedTaskRepository()
  const task = repo.getTask(taskId)
  if (!task || task.state !== 'blocked' || task.preBlockState !== 'awaiting_plan_review') {
    return reviewFailure('illegal_transition')
  }

  // Unblock through the EXISTING `retry` rule rather than a bespoke SQL write,
  // so the blocked -> pre_block_state edge keeps exactly one definition.
  const validation = validateRetryTransition(task.state, task.preBlockState)
  if (!validation.ok) {
    return reviewFailure('illegal_transition')
  }
  const restored = repo.applyTransition({
    taskId,
    fromState: 'blocked',
    toState: 'awaiting_plan_review',
    actor: 'human',
    eventType: 'plan_review_retry',
    preBlockState: null,
    blockedReasonCode: null,
    blockedPhase: null
  })
  if (!restored.ok) {
    return reviewFailure('lock_contended')
  }
  broadcastIfProjectable(taskId)

  // Re-runs the FULL admission path, including the artifact-currency re-check:
  // the plan may have been revised while the task sat blocked.
  return startPlanAudit(taskId)
}

/**
 * Cancels a running audit. The kill precedes the transaction — committing while
 * the process still runs would leave a live process with no `running` row.
 * Runs NO Git command.
 */
export async function cancelPlanAudit(taskId: string): Promise<PlanReviewCommandResult> {
  const repo = getAuditedTaskRepository()
  const running = getRunningPlanReviewRun(repo.getDatabase(), taskId)
  if (!running) {
    return reviewFailure('lock_contended')
  }

  const { killCodexProcess, markCodexCancelRequested } = await import('./audited-codex-process')
  markCodexCancelRequested(running.id)
  await killCodexProcess(running.id)

  // A partially written result file must never be readable as this run's
  // verdict, so it is removed before the run becomes terminal.
  removeLastMessageFile(getLastMessagePath(app.getPath('userData'), running.id))

  const result = cancelPlanReviewRun(repo.getDatabase(), { runId: running.id, taskId }, Date.now())
  broadcastIfProjectable(taskId)
  return result.ok ? { ok: true } : reviewFailure('lock_contended')
}

/** Approve for Implementation. */
export function approvePlanForImplementation(taskId: string): PlanApprovalCommandResult {
  const repo = getAuditedTaskRepository()
  const result = approvePlan(repo.getDatabase(), taskId, Date.now())
  broadcastIfProjectable(taskId)
  return result
}

/**
 * Request Plan Revision: records the human transition into `planning`, then
 * starts an ORDINARY plan-mode execution. If the execution refuses, the task
 * rests in `planning` with no run and the existing Start affordance resumes it —
 * the revision transition is not rolled back, because it genuinely happened.
 */
export async function requestPlanRevisionAndStart(
  taskId: string
): Promise<PlanRevisionCommandResult> {
  const repo = getAuditedTaskRepository()
  const revised = requestPlanRevision(repo.getDatabase(), taskId, Date.now())
  if (!revised.ok) {
    return revised
  }
  broadcastIfProjectable(taskId)

  const started: ExecutionCommandResult = await startExecution(taskId)
  broadcastIfProjectable(taskId)
  if (started.ok) {
    return { ok: true }
  }
  if (started.kind === 'worktree') {
    return { ok: false, reasonCode: 'worktree_not_verified' }
  }
  return {
    ok: false,
    reasonCode:
      started.reasonCode === 'prompt_unavailable'
        ? 'prompt_unavailable'
        : started.reasonCode === 'lock_contended'
          ? 'lock_contended'
          : 'illegal_transition'
  }
}

/**
 * Fail-safe by design: runs during IPC handler registration, where an exception
 * would abort registration and leave the app with no handlers at all.
 */
export function recoverInterruptedPlanReviewsOnStartup(): void {
  try {
    const repo = getAuditedTaskRepository()
    const recovered = recoverInterruptedPlanReviewRuns(repo.getDatabase(), Date.now())
    for (const { taskId } of recovered) {
      broadcastIfProjectable(taskId)
    }
  } catch (error) {
    console.error('[auditedWorkflow] Interrupted plan-review recovery failed:', error)
  }
}

function parseDescription(specJson: string): string {
  try {
    const parsed = JSON.parse(specJson) as { description?: unknown }
    return typeof parsed.description === 'string' ? parsed.description : ''
  } catch {
    return ''
  }
}
