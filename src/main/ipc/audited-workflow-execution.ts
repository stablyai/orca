// Phase 4 execution IPC handlers. Split from ipc/audited-workflow.ts to stay
// under the max-lines budget without a suppression.
//
// Electron IPC only — no RPC method is registered for any of these, preserved by
// mobile-rpc-allowlist.test.ts.
import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  startExecution,
  cancelExecution,
  retryExecution
} from '../audited-workflow/audited-execution-orchestration'
import type {
  AuditedWorkflowStartExecutionParams,
  AuditedWorkflowStartExecutionResult,
  AuditedWorkflowCancelExecutionParams,
  AuditedWorkflowCancelExecutionResult,
  AuditedWorkflowRetryExecutionParams,
  AuditedWorkflowRetryExecutionResult
} from '../../shared/audited-workflow-command-types'

// { taskId } and NOTHING else. Mode, prompt, model, and argv are all derived in
// main from durable state — .strict() REJECTS an extra key rather than stripping
// it, so a renderer attempt to influence them is a hard error, not a silent
// no-op that would hide a caller bug.
const StartExecutionParams = z.object({ taskId: z.string().min(1) }).strict()
const CancelExecutionParams = z.object({ taskId: z.string().min(1) }).strict()
const RetryExecutionParams = z.object({ taskId: z.string().min(1) }).strict()

export function registerAuditedExecutionHandlers(): void {
  ipcMain.handle(
    'auditedWorkflow:startExecution',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowStartExecutionResult> => {
      const args: AuditedWorkflowStartExecutionParams = StartExecutionParams.parse(rawArgs)
      try {
        return await startExecution(args.taskId)
      } catch (error) {
        // The raw error may embed an absolute path, argv, or agent output — it
        // is logged locally and never forwarded to the renderer.
        console.error('[auditedWorkflow] startExecution failed unexpectedly:', error)
        return { ok: false, kind: 'execution', reasonCode: 'spawn_failed' }
      }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:cancelExecution',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowCancelExecutionResult> => {
      const args: AuditedWorkflowCancelExecutionParams = CancelExecutionParams.parse(rawArgs)
      try {
        return await cancelExecution(args.taskId)
      } catch (error) {
        console.error('[auditedWorkflow] cancelExecution failed unexpectedly:', error)
        return { ok: false, kind: 'execution', reasonCode: 'lock_contended' }
      }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:retryExecution',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowRetryExecutionResult> => {
      const args: AuditedWorkflowRetryExecutionParams = RetryExecutionParams.parse(rawArgs)
      try {
        return await retryExecution(args.taskId)
      } catch (error) {
        console.error('[auditedWorkflow] retryExecution failed unexpectedly:', error)
        return { ok: false, kind: 'execution', reasonCode: 'lock_contended' }
      }
    }
  )
}
