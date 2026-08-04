// "Run / Cancel / Retry Codex code audit", plus Request Fix (Phase 7).
//
// Ordering is load-bearing and mirrors startPlanAudit: nothing is spawned until
// the worktree is verified AND the candidate is proven current inside the same
// transaction that creates the run row. A verdict can therefore only ever be
// produced for a candidate that was current at admission.
//
// PHASE 7'S EXTRA GUARD. A `fix` run's active state IS awaiting_code_audit, so
// unlike the plan lane this state is not quiescent: Claude may be editing the
// worktree right now. Every path below refuses while an execution run is live,
// and the refusal is re-checked inside the admission CAS where it is sound.
import { app } from 'electron'
import type { CodeAuditReasonCode } from '../../shared/audited-code-audit-types'
import { getAuditedTaskRepository, getTaskProjection } from './audited-task-service'
import { broadcastAuditedTaskChanged } from './audited-workflow-broadcast'
import { verifyWorktreeForTask } from './audited-worktree-service'
import { getCurrentCandidate } from './audited-candidate-repository'
import { deriveCandidateTree } from './audited-candidate-identity'
import { hasLiveExecutionRun } from './audited-execution-run-repository'
import { getRunningCodeAuditRun, startCodeAuditRun } from './audited-code-audit-run-repository'
import { cancelCodeAuditRun } from './audited-code-audit-run-cancel'
import { recoverInterruptedCodeAuditRuns } from './audited-code-audit-run-recovery'
import { buildCodeAuditPrompt } from './audited-code-audit-prompt'
import { launchAndFinalizeCodeAudit } from './audited-code-audit-launch'
import { getCodeAuditLastMessagePath } from './audited-code-audit-paths'
import { resolveAcceptanceCriteria } from './audited-plan-audit-criteria'
import { resolveAuditedCodexProvider } from './audited-codex-provider-settings'
import { removeLastMessageFile } from './audited-plan-audit-verdict'
import { requestCodeFix } from './audited-code-audit-fix'
import { validateRetryTransition } from './audited-workflow-state-machine'
import type { AuditedWorkflowCodeAuditResult } from '../../shared/audited-workflow-command-types'

// The IPC contract is the single definition; re-exported here so main-side
// callers read the same shape the renderer receives.
export type CodeAuditCommandResult = AuditedWorkflowCodeAuditResult

function broadcastIfProjectable(taskId: string): void {
  const projection = getTaskProjection(taskId)
  if (projection) {
    broadcastAuditedTaskChanged(projection)
  }
}

function auditFailure(reasonCode: CodeAuditReasonCode): CodeAuditCommandResult {
  return { ok: false, kind: 'codeAudit', reasonCode }
}

export { requestCodeFix } from './audited-code-audit-fix'
export { getCodeAuditLastMessagePath, getCodeAuditRunDir } from './audited-code-audit-paths'

/**
 * Starts one Codex code audit.
 *
 * The candidate tree is RECOMPUTED before admission — not merely looked up. A
 * plan artifact is bytes on disk whose hash proves currency; a candidate is
 * derived state, so the only equivalent proof is deriving it again and comparing.
 */
export async function startCodeAudit(taskId: string): Promise<CodeAuditCommandResult> {
  const repo = getAuditedTaskRepository()
  const db = repo.getDatabase()

  const snapshot = repo.getTask(taskId)
  if (!snapshot || snapshot.state !== 'awaiting_code_audit') {
    return auditFailure('illegal_transition')
  }

  // Step 0 — THE FIX-LANE GUARD, pre-admission. Truthful and fast; the
  // authoritative re-check happens inside startCodeAuditRun's transaction.
  if (hasLiveExecutionRun(db, taskId)) {
    return auditFailure('execution_in_progress')
  }

  // Read-only verification before any model invocation. NOTE this AWAITS, and
  // verification reloads durable state — so `snapshot` is stale from here on.
  const verified = await verifyWorktreeForTask(taskId)
  if (!verified.ok) {
    return { ok: false, kind: 'worktree', reasonCode: verified.reasonCode }
  }

  // RELOAD. Everything below comes from THIS row.
  const task = repo.getTask(taskId)
  if (!task || task.state !== 'awaiting_code_audit') {
    return auditFailure('illegal_transition')
  }
  if (
    !task.worktreePath ||
    !task.branchName ||
    !task.worktreeProvenance ||
    task.worktreeVerifiedAt === null ||
    task.worktreeReasonCode !== null
  ) {
    return auditFailure('worktree_not_verified')
  }
  if (task.worktreePath !== snapshot.worktreePath || task.branchName !== snapshot.branchName) {
    return auditFailure('worktree_identity_changed')
  }
  const expectedWorktreeIdentity = {
    worktreePath: task.worktreePath,
    branchName: task.branchName,
    worktreeProvenance: task.worktreeProvenance,
    worktreeVerifiedAt: task.worktreeVerifiedAt,
    worktreeReasonCode: null
  } as const

  const candidate = getCurrentCandidate(db, taskId)
  if (!candidate || candidate.id !== task.currentCandidateId) {
    return auditFailure('candidate_unavailable')
  }

  // THE RECOMPUTATION. If the worktree no longer produces the recorded tree, the
  // candidate does not describe what Codex would read, so no audit may start.
  const recomputed = await deriveCandidateTree({
    runId: `${candidate.id}_admit`,
    userDataPath: app.getPath('userData'),
    worktreePath: task.worktreePath,
    sourceRepoPath: task.sourceRepoPath,
    baseCommit: task.baseCommit,
    wslDistro: task.wslDistro,
    hostId: task.hostId
  })
  if (!recomputed.ok) {
    // `duplicate_candidate` is an ATTACH-time code and unreachable from a pure
    // derivation; mapping it rather than widening the audit union keeps that
    // vocabulary honest about what this lane can actually report.
    return auditFailure(
      recomputed.reasonCode === 'duplicate_candidate'
        ? 'candidate_derivation_failed'
        : recomputed.reasonCode
    )
  }
  if (recomputed.treeOid !== candidate.treeOid) {
    return auditFailure('candidate_drift')
  }

  const criteria = resolveAcceptanceCriteria(db, taskId)
  if (!criteria.ok) {
    return auditFailure('candidate_unavailable')
  }

  // PRE-ADMISSION provider resolution: a configuration problem never reached
  // Codex, so it must not create a run row or block the task.
  const providerResolution = resolveAuditedCodexProvider()
  if (!providerResolution.ok) {
    return auditFailure(providerResolution.reasonCode as CodeAuditReasonCode)
  }

  const nowMs = Date.now()
  const started = startCodeAuditRun(
    db,
    {
      taskId,
      candidateId: candidate.id,
      candidateTreeOid: candidate.treeOid,
      round: task.fixRound,
      worktreeVerifiedAtMs: nowMs,
      expectedWorktreeIdentity
    },
    nowMs
  )
  if (!started.ok) {
    return auditFailure(started.reasonCode)
  }
  broadcastIfProjectable(taskId)

  await launchAndFinalizeCodeAudit(
    {
      runId: started.runId,
      taskId,
      // The CAS-CONFIRMED path, read inside the admission transaction.
      worktreePath: started.worktreePath,
      prompt: buildCodeAuditPrompt({
        title: task.title,
        description: parseDescription(task.specJson),
        acceptanceCriteria: criteria.criteria,
        baseCommit: task.baseCommit,
        fixRound: task.fixRound
      })
    },
    task
  )
  return { ok: true }
}

/**
 * Cancels a running audit. The kill precedes the transaction — committing while
 * the process still runs would leave a live process with no `running` row.
 * Runs NO Git command.
 */
export async function cancelCodeAudit(taskId: string): Promise<CodeAuditCommandResult> {
  const repo = getAuditedTaskRepository()
  const running = getRunningCodeAuditRun(repo.getDatabase(), taskId)
  if (!running) {
    return auditFailure('lock_contended')
  }

  const { killCodexProcess, markCodexCancelRequested } = await import('./audited-codex-process')
  markCodexCancelRequested(running.id)
  await killCodexProcess(running.id)

  removeLastMessageFile(getCodeAuditLastMessagePath(app.getPath('userData'), running.id))

  const result = cancelCodeAuditRun(repo.getDatabase(), { runId: running.id, taskId }, Date.now())
  broadcastIfProjectable(taskId)
  return result.ok ? { ok: true } : auditFailure('lock_contended')
}

/**
 * Retries an audit for a task blocked by a retryable failure. Re-runs the FULL
 * admission path — including the recomputation — since the worktree may have
 * changed while the task sat blocked.
 */
export async function retryCodeAudit(taskId: string): Promise<CodeAuditCommandResult> {
  const repo = getAuditedTaskRepository()
  const task = repo.getTask(taskId)
  if (!task || task.state !== 'blocked' || task.preBlockState !== 'awaiting_code_audit') {
    return auditFailure('illegal_transition')
  }

  const validation = validateRetryTransition(task.state, task.preBlockState)
  if (!validation.ok) {
    return auditFailure('illegal_transition')
  }
  const restored = repo.applyTransition({
    taskId,
    fromState: 'blocked',
    toState: 'awaiting_code_audit',
    actor: 'human',
    eventType: 'code_audit_retry',
    preBlockState: null,
    blockedReasonCode: null,
    blockedPhase: null
  })
  if (!restored.ok) {
    return auditFailure('lock_contended')
  }
  broadcastIfProjectable(taskId)

  return startCodeAudit(taskId)
}

/**
 * Request Fix: records the human transition, then starts an ORDINARY fix-mode
 * execution. If the execution refuses, the task rests in awaiting_code_audit with
 * no run and the existing Start affordance resumes it — the fix transition is not
 * rolled back, because it genuinely happened. Mirrors requestPlanRevisionAndStart.
 */
export async function requestCodeFixAndStart(taskId: string): Promise<CodeAuditCommandResult> {
  const repo = getAuditedTaskRepository()
  const requested = requestCodeFix(repo.getDatabase(), taskId, Date.now())
  if (!requested.ok) {
    return auditFailure(requested.reasonCode)
  }
  broadcastIfProjectable(taskId)

  const { startExecution } = await import('./audited-execution-orchestration')
  const started = await startExecution(taskId)
  broadcastIfProjectable(taskId)
  if (started.ok) {
    return { ok: true }
  }
  if (started.kind === 'worktree') {
    return { ok: false, kind: 'worktree', reasonCode: started.reasonCode }
  }
  return auditFailure(
    started.reasonCode === 'lock_contended' ? 'lock_contended' : 'illegal_transition'
  )
}

/**
 * Fail-safe by design: runs during IPC handler registration, where an exception
 * would abort registration and leave the app with no handlers at all.
 */
export function recoverInterruptedCodeAuditsOnStartup(): void {
  try {
    const repo = getAuditedTaskRepository()
    const recovered = recoverInterruptedCodeAuditRuns(repo.getDatabase(), Date.now())
    for (const { taskId } of recovered) {
      broadcastIfProjectable(taskId)
    }
  } catch (error) {
    console.error('[auditedWorkflow] Interrupted code-audit recovery failed:', error)
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
