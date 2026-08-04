// IPC surface for the Phase 8 approval + commit lane. Split from
// ipc/audited-workflow.ts so that file stays within its line budget without a
// max-lines suppression.
//
// Electron-IPC only: no RPC method is registered for any audited-workflow
// channel, and the mobile allowlist test enforces that.
//
// THE RENDERER SUPPLIES ONLY A taskId, A TTL PRESET NAME, AND THE MESSAGE. There
// is no `approver` parameter: a renderer-supplied identity would be unverifiable,
// so main derives every authority from durable state. There is no treeOid
// parameter either — the tree a commit is bound to is read from the approval row
// inside the admission transaction, never echoed back from the client.
import { ipcMain } from 'electron'
import { z } from 'zod'
import { APPROVAL_TTL_PRESETS } from '../../shared/audited-workflow-types'
import { MAX_COMMIT_MESSAGE_BYTES } from '../../shared/audited-commit-types'
import type {
  AuditedWorkflowApproveResult,
  AuditedWorkflowCommitResult,
  AuditedWorkflowRevokeApprovalResult
} from '../../shared/audited-workflow-command-types'
import {
  getAuditedTaskRepository,
  getTaskProjection
} from '../audited-workflow/audited-task-service'
import { broadcastAuditedTaskChanged } from '../audited-workflow/audited-workflow-broadcast'
import { grantApproval, revokeApproval } from '../audited-workflow/audited-approval-commands'
import { startCommit } from '../audited-workflow/audited-commit-orchestration'

// Why .strict(): an extra treeOid/path/approver key must be REJECTED, not
// silently stripped — the renderer must never influence commit identity, and a
// stripped key would hide a caller bug.
const ApproveParams = z
  .object({
    taskId: z.string().min(1),
    ttlPreset: z.enum(APPROVAL_TTL_PRESETS)
  })
  .strict()

const TaskOnlyParams = z.object({ taskId: z.string().min(1) }).strict()

const CommitParams = z
  .object({
    taskId: z.string().min(1),
    // Bounded here AND canonicalized in main; the two are independent defenses.
    message: z.string().min(1).max(MAX_COMMIT_MESSAGE_BYTES)
  })
  .strict()

function broadcastIfProjectable(taskId: string): void {
  const projection = getTaskProjection(taskId)
  if (projection) {
    broadcastAuditedTaskChanged(projection)
  }
}

export function registerAuditedWorkflowCommitHandlers(): void {
  ipcMain.handle(
    'auditedWorkflow:approve',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowApproveResult> => {
      const args = ApproveParams.parse(rawArgs)
      try {
        const db = getAuditedTaskRepository().getDatabase()
        const result = grantApproval(db, args.taskId, args.ttlPreset, Date.now())
        broadcastIfProjectable(args.taskId)
        return result.ok
          ? { ok: true }
          : { ok: false, kind: 'approval', reasonCode: result.reasonCode }
      } catch (error) {
        console.error('[auditedWorkflow] approve failed unexpectedly:', error)
        return { ok: false, kind: 'approval', reasonCode: 'lock_contended' }
      }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:revokeApproval',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowRevokeApprovalResult> => {
      const args = TaskOnlyParams.parse(rawArgs)
      try {
        const db = getAuditedTaskRepository().getDatabase()
        const result = revokeApproval(db, args.taskId, Date.now())
        broadcastIfProjectable(args.taskId)
        return result.ok
          ? { ok: true }
          : { ok: false, kind: 'approval', reasonCode: result.reasonCode }
      } catch (error) {
        console.error('[auditedWorkflow] revokeApproval failed unexpectedly:', error)
        return { ok: false, kind: 'approval', reasonCode: 'lock_contended' }
      }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:commit',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowCommitResult> => {
      const args = CommitParams.parse(rawArgs)
      try {
        return await startCommit(args.taskId, args.message)
      } catch (error) {
        // The raw error stays local — never projected, and never carrying the
        // message, a path, or Git stderr.
        console.error('[auditedWorkflow] commit failed unexpectedly:', error)
        return { ok: false, kind: 'commit', reasonCode: 'lock_contended' }
      }
    }
  )
}
