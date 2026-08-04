// Phase 5 plan-review IPC handlers. Split from ipc/audited-workflow.ts to stay
// under the max-lines budget without a suppression.
//
// Electron IPC only — no RPC method is registered for any of these, preserved by
// mobile-rpc-allowlist.test.ts. The plan body and Codex verdicts never reach a
// mobile or remote client.
import { app, ipcMain } from 'electron'
import { z } from 'zod'
import {
  startPlanAudit,
  cancelPlanAudit,
  retryPlanAudit,
  approvePlanForImplementation,
  requestPlanRevisionAndStart
} from '../audited-workflow/audited-plan-review-orchestration'
import { getAuditedTaskRepository } from '../audited-workflow/audited-task-service'
import { getPlanArtifact } from '../audited-workflow/audited-plan-artifact-repository'
import { readVerifiedPlanArtifact } from '../audited-workflow/audited-plan-artifact-store'
import type {
  AuditedWorkflowStartPlanAuditParams,
  AuditedWorkflowStartPlanAuditResult,
  AuditedWorkflowCancelPlanAuditParams,
  AuditedWorkflowCancelPlanAuditResult,
  AuditedWorkflowRetryPlanAuditParams,
  AuditedWorkflowRetryPlanAuditResult,
  AuditedWorkflowApprovePlanParams,
  AuditedWorkflowApprovePlanResult,
  AuditedWorkflowRequestPlanRevisionParams,
  AuditedWorkflowRequestPlanRevisionResult,
  AuditedWorkflowGetPlanArtifactParams,
  AuditedWorkflowGetPlanArtifactResult
} from '../../shared/audited-workflow-command-types'

// { taskId } and NOTHING else. Model, prompt, cwd, argv, and the output path are
// derived in main from durable state — .strict() REJECTS an extra key rather
// than stripping it, so a renderer attempt to influence them is a hard error.
const TaskOnlyParams = z.object({ taskId: z.string().min(1) }).strict()
// artifactId is an opaque row id the renderer received on the projection. It is
// re-verified against the task below, so echoing back a foreign id cannot read
// another task's plan.
const GetPlanArtifactParams = z
  .object({ taskId: z.string().min(1), artifactId: z.string().min(1) })
  .strict()

export function registerAuditedPlanReviewHandlers(): void {
  ipcMain.handle(
    'auditedWorkflow:startPlanAudit',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowStartPlanAuditResult> => {
      const args: AuditedWorkflowStartPlanAuditParams = TaskOnlyParams.parse(rawArgs)
      try {
        return (await startPlanAudit(args.taskId)) as AuditedWorkflowStartPlanAuditResult
      } catch (error) {
        // The raw error may embed an absolute path, argv, or agent output — it
        // is logged locally and never forwarded to the renderer.
        console.error('[auditedWorkflow] startPlanAudit failed unexpectedly:', error)
        return { ok: false, kind: 'planReview', reasonCode: 'spawn_failed' }
      }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:cancelPlanAudit',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowCancelPlanAuditResult> => {
      const args: AuditedWorkflowCancelPlanAuditParams = TaskOnlyParams.parse(rawArgs)
      try {
        return (await cancelPlanAudit(args.taskId)) as AuditedWorkflowCancelPlanAuditResult
      } catch (error) {
        console.error('[auditedWorkflow] cancelPlanAudit failed unexpectedly:', error)
        return { ok: false, kind: 'planReview', reasonCode: 'lock_contended' }
      }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:retryPlanAudit',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowRetryPlanAuditResult> => {
      const args: AuditedWorkflowRetryPlanAuditParams = TaskOnlyParams.parse(rawArgs)
      try {
        return (await retryPlanAudit(args.taskId)) as AuditedWorkflowRetryPlanAuditResult
      } catch (error) {
        console.error('[auditedWorkflow] retryPlanAudit failed unexpectedly:', error)
        return { ok: false, kind: 'planReview', reasonCode: 'lock_contended' }
      }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:approvePlan',
    (_event, rawArgs: unknown): AuditedWorkflowApprovePlanResult => {
      const args: AuditedWorkflowApprovePlanParams = TaskOnlyParams.parse(rawArgs)
      try {
        return approvePlanForImplementation(args.taskId)
      } catch (error) {
        console.error('[auditedWorkflow] approvePlan failed unexpectedly:', error)
        return { ok: false, reasonCode: 'lock_contended' }
      }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:requestPlanRevision',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowRequestPlanRevisionResult> => {
      const args: AuditedWorkflowRequestPlanRevisionParams = TaskOnlyParams.parse(rawArgs)
      try {
        return await requestPlanRevisionAndStart(args.taskId)
      } catch (error) {
        console.error('[auditedWorkflow] requestPlanRevision failed unexpectedly:', error)
        return { ok: false, reasonCode: 'lock_contended' }
      }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:getPlanArtifact',
    (_event, rawArgs: unknown): AuditedWorkflowGetPlanArtifactResult => {
      const args: AuditedWorkflowGetPlanArtifactParams = GetPlanArtifactParams.parse(rawArgs)
      try {
        const artifact = getPlanArtifact(getAuditedTaskRepository().getDatabase(), args.artifactId)
        // OWNERSHIP CHECK: an artifact id belonging to another task is refused
        // with the same closed code as a missing one, so this can never become a
        // cross-task read primitive.
        if (!artifact || artifact.taskId !== args.taskId) {
          return { ok: false, reasonCode: 'artifact_unavailable' }
        }
        // Superseded artifacts are served too, so the UI can show what an
        // earlier round said. Only the CURRENT one is approvable.
        //
        // The SAME hash verification the audit path applies: the human must not
        // be shown a body that differs from the bytes the artifact row — and
        // therefore every downstream authorization — refers to. A tampered file
        // fails here rather than being rendered as the reviewed plan.
        const verified = readVerifiedPlanArtifact(
          app.getPath('userData'),
          artifact.id,
          artifact.contentSha256
        )
        if (!verified.ok) {
          // Both failure kinds collapse to one renderer-visible code: the body
          // is not available to show, and the distinction is a main-side detail.
          return { ok: false, reasonCode: 'artifact_unavailable' }
        }
        return {
          ok: true,
          text: verified.text,
          truncated: artifact.truncated,
          redactionCount: artifact.redactionCount,
          round: artifact.round,
          status: artifact.status
        }
      } catch (error) {
        console.error('[auditedWorkflow] getPlanArtifact failed unexpectedly:', error)
        return { ok: false, reasonCode: 'artifact_unavailable' }
      }
    }
  )
}
