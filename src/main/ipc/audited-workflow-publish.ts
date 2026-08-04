// IPC surface for the Phase 9 publish lane. Split from ipc/audited-workflow.ts
// so that file stays within its line budget without a max-lines suppression.
//
// Electron-IPC only: no RPC method is registered for any audited-workflow
// channel, and the mobile allowlist test enforces that.
//
// THE RENDERER SUPPLIES ONLY A taskId (plus an optional draft flag). There is no
// sha, branch, remote, provider, classification, or URL parameter: publish
// identity is read from durable state inside the admission transaction, never
// echoed back from the client, and an outcome is never dictated by the caller.
import { ipcMain } from 'electron'
import { z } from 'zod'
import type {
  AuditedWorkflowCreateReviewRequestResult,
  AuditedWorkflowPublishResult,
  AuditedWorkflowRecheckPublishResult
} from '../../shared/audited-workflow-command-types'
import {
  createReviewRequest,
  recheckPublish,
  startPublish
} from '../audited-workflow/audited-publish-orchestration'

// Why .strict(): an extra sha/remote/branch/provider key must be REJECTED, not
// silently stripped — the renderer must never influence publish identity, and a
// stripped key would hide a caller bug.
const PublishParams = z
  .object({
    taskId: z.string().min(1),
    draft: z.boolean().optional()
  })
  .strict()

const TaskOnlyParams = z.object({ taskId: z.string().min(1) }).strict()

export function registerAuditedWorkflowPublishHandlers(): void {
  ipcMain.handle(
    'auditedWorkflow:publish',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowPublishResult> => {
      const args = PublishParams.parse(rawArgs)
      try {
        return await startPublish(args.taskId, { draft: args.draft })
      } catch (error) {
        // The raw error stays local — never projected, and never carrying a
        // remote URL, a token, argv, or Git stderr.
        console.error('[auditedWorkflow] publish failed unexpectedly:', error)
        return { ok: false, kind: 'publish', reasonCode: 'lock_contended' }
      }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:recheckPublish',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowRecheckPublishResult> => {
      const args = TaskOnlyParams.parse(rawArgs)
      try {
        return await recheckPublish(args.taskId)
      } catch (error) {
        console.error('[auditedWorkflow] recheckPublish failed unexpectedly:', error)
        return { ok: false, kind: 'publish', reasonCode: 'lock_contended' }
      }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:createReviewRequest',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowCreateReviewRequestResult> => {
      const args = PublishParams.parse(rawArgs)
      try {
        return await createReviewRequest(args.taskId, { draft: args.draft })
      } catch (error) {
        console.error('[auditedWorkflow] createReviewRequest failed unexpectedly:', error)
        return { ok: false, kind: 'publish', reasonCode: 'lock_contended' }
      }
    }
  )
}
