// Startup recovery and reconciliation for the audited workflow.
//
// Split from ipc/audited-workflow.ts so that file stays within its line budget
// without a max-lines suppression. ORDERING IS LOAD-BEARING and is documented at
// each step; the caller invokes this immediately after the worktree registry is
// warm and before any handler is registered.
import { app } from 'electron'
import {
  getAuditedTaskRepository,
  getTaskProjection
} from '../audited-workflow/audited-task-service'
import { broadcastAuditedTaskChanged } from '../audited-workflow/audited-workflow-broadcast'
import { recoverInterruptedTriageRunsOnStartup } from '../audited-workflow/audited-triage-orchestration'
import { recoverInterruptedExecutionsOnStartup } from '../audited-workflow/audited-execution-orchestration'
import { recoverInterruptedPlanReviewsOnStartup } from '../audited-workflow/audited-plan-review-orchestration'
import { recoverInterruptedCodeAuditsOnStartup } from '../audited-workflow/audited-code-audit-orchestration'
import { reconcilePlanArtifactFilesOnStartup } from '../audited-workflow/audited-plan-artifact-gc'
import { reconcileAuditedWorktreesOnStartup } from '../audited-workflow/audited-worktree-service'
import { sweepCandidateStoresOnStartup } from '../audited-workflow/audited-candidate-store-gc'
import { recoverInterruptedCommitAttempts } from '../audited-workflow/audited-commit-run-recovery'
import { recoverInterruptedPublishAttempts } from '../audited-workflow/audited-publish-run-recovery'
import { recoverInterruptedLandAttempts } from '../audited-workflow/audited-land-run-recovery'

export function runAuditedWorkflowStartupRecovery(): void {
  // Why: runs once per registration (i.e. once per app process lifetime —
  // registerAuditedWorkflowHandlers is called exactly once from
  // register-core-handlers.ts). Idempotent and CAS-safe, so calling it again
  // (e.g. in a test that re-registers handlers) is harmless — a second pass
  // finds nothing left in 'running' state to recover.
  recoverInterruptedTriageRunsOnStartup()

  // Same rationale, for execution runs: a `running` row cannot be assumed alive
  // after a restart, so every one is marked `interrupted` and its task blocked
  // with pre_block_state set. Idempotent and CAS-safe.
  recoverInterruptedExecutionsOnStartup()

  // Same rationale for plan-review runs: a `running` Codex review cannot be
  // assumed alive after a restart. Idempotent and CAS-safe.
  recoverInterruptedPlanReviewsOnStartup()

  // Same rationale for code-audit runs. Note candidate DERIVATION needs no
  // recovery sweep: its objects live only in a per-run temp directory, so an
  // interrupted derivation leaves nothing in the repository to reclaim.
  recoverInterruptedCodeAuditsOnStartup()

  // Reclaims artifact files whose DB row never committed (a crash or a lost
  // ownership race between the atomic rename and the attach transaction).
  // Conservative: only well-formed ids with no row in ANY status are removed.
  try {
    reconcilePlanArtifactFilesOnStartup(
      getAuditedTaskRepository().getDatabase(),
      app.getPath('userData')
    )
  } catch (error) {
    console.error('[auditedWorkflow] Plan artifact reconciliation failed to start:', error)
  }

  // Phase 8 candidate-store sweep. MUST run before any new reservation can be
  // taken: it expires every `held` reservation unconditionally, which is sound
  // ONLY at startup because any promotion that could own one belonged to a
  // previous process. Elapsed time never releases a reservation while the app is
  // live — a long-running promotion keeps its bytes reserved however long it
  // takes. Also releases accounting for terminal/TTL-lapsed/superseded stores and
  // removes their directories.
  try {
    sweepCandidateStoresOnStartup(
      getAuditedTaskRepository().getDatabase(),
      app.getPath('userData'),
      Date.now()
    )
  } catch (error) {
    console.error('[auditedWorkflow] Candidate store sweep failed to start:', error)
  }

  // Phase 8 commit-attempt recovery. Reads Git, so it is async; each attempt is
  // independently CAS-guarded, so ordering against the fire-and-forget worktree
  // reconciliation below does not matter.
  //
  // The try/catch wraps the SYNCHRONOUS setup too, not just the promise: resolving
  // the repository can itself throw, and a bare `.catch()` would not see that. An
  // exception escaping here would abort registration and leave the app with no
  // handlers at all.
  try {
    void recoverInterruptedCommitAttempts(getAuditedTaskRepository().getDatabase(), Date.now())
      .then((recovered) => {
        for (const { taskId } of recovered) {
          const projection = getTaskProjection(taskId)
          if (projection) {
            broadcastAuditedTaskChanged(projection)
          }
        }
      })
      .catch((error) => {
        console.error('[auditedWorkflow] Commit attempt recovery failed:', error)
      })
  } catch (error) {
    console.error('[auditedWorkflow] Commit attempt recovery failed to start:', error)
  }

  // Phase 9 publish-attempt recovery. Reads the REMOTE (ls-remote) and NEVER
  // pushes: recovery classifies, it does not act, because a network mutation at
  // startup would have no human intent behind it. An attempt whose remote cannot
  // be read is left `authorized` on purpose — that is what stops a second push
  // from starting before the user's explicit Recheck resolves it.
  //
  // The try/catch wraps the SYNCHRONOUS setup too, not just the promise:
  // resolving the repository can itself throw, and a bare `.catch()` would not
  // see that.
  try {
    void recoverInterruptedPublishAttempts(getAuditedTaskRepository().getDatabase(), Date.now())
      .then((recovered) => {
        for (const { taskId } of recovered) {
          const projection = getTaskProjection(taskId)
          if (projection) {
            broadcastAuditedTaskChanged(projection)
          }
        }
      })
      .catch((error) => {
        console.error('[auditedWorkflow] Publish attempt recovery failed:', error)
      })
  } catch (error) {
    console.error('[auditedWorkflow] Publish attempt recovery failed to start:', error)
  }

  // Phase 10 land-attempt recovery. Reads the user's SOURCE repository and NEVER
  // moves a ref or touches an index: recovery classifies, it does not act,
  // because re-applying a mutation to a workspace Orca does not own would have no
  // human intent behind it. An attempt whose evidence is unreadable is left
  // guarded on purpose.
  //
  // The publication gate is NOT re-evaluated here — it is an admission
  // precondition, and re-litigating it would let a later publish failure strand a
  // durable, already-applied land.
  //
  // The try/catch wraps the SYNCHRONOUS setup too, not just the promise:
  // resolving the repository can itself throw, and a bare `.catch()` would not
  // see that.
  try {
    void recoverInterruptedLandAttempts(getAuditedTaskRepository().getDatabase(), Date.now())
      .then((recovered) => {
        for (const { taskId } of recovered) {
          const projection = getTaskProjection(taskId)
          if (projection) {
            broadcastAuditedTaskChanged(projection)
          }
        }
      })
      .catch((error) => {
        console.error('[auditedWorkflow] Land attempt recovery failed:', error)
      })
  } catch (error) {
    console.error('[auditedWorkflow] Land attempt recovery failed to start:', error)
  }

  // Read-only, network-free, Git-mutation-free. Fire-and-forget so handler
  // registration is never blocked on filesystem/Git probes; failures are logged
  // locally and never surface a raw error.
  void reconcileAuditedWorktreesOnStartup().catch((error) => {
    console.error('[auditedWorkflow] Worktree reconciliation failed:', error)
  })
}
