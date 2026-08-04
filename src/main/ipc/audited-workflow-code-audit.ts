// Phase 7 code-audit IPC handlers. Split from ipc/audited-workflow.ts to stay
// under the max-lines budget without a suppression.
//
// Electron IPC only — no RPC method is registered for any of these, preserved by
// mobile-rpc-allowlist.test.ts. Candidate tree OIDs and Codex verdicts never
// reach a mobile or remote client.
import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  startCodeAudit,
  cancelCodeAudit,
  retryCodeAudit,
  requestCodeFixAndStart
} from '../audited-workflow/audited-code-audit-orchestration'
import type { AuditedWorkflowCodeAuditResult } from '../../shared/audited-workflow-command-types'

// { taskId } and NOTHING else. Model, prompt, cwd, argv, the output path, and the
// candidate identity are all derived in main from durable state — .strict()
// REJECTS an extra key rather than stripping it, so a renderer attempt to
// influence them is a hard error rather than a silent no-op.
//
// In particular there is no `treeOid` parameter anywhere: the tree a run is bound
// to is read from the candidate row inside the admission transaction, never
// echoed back from the client.
const TaskOnlyParams = z.object({ taskId: z.string().min(1) }).strict()

export function registerAuditedCodeAuditHandlers(): void {
  ipcMain.handle(
    'auditedWorkflow:startCodeAudit',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowCodeAuditResult> => {
      const args = TaskOnlyParams.parse(rawArgs)
      try {
        return await startCodeAudit(args.taskId)
      } catch (error) {
        // The raw error may embed an absolute path, argv, or agent output — it is
        // logged locally and never forwarded to the renderer.
        console.error('[auditedWorkflow] startCodeAudit failed unexpectedly:', error)
        return { ok: false, kind: 'codeAudit', reasonCode: 'spawn_failed' }
      }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:cancelCodeAudit',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowCodeAuditResult> => {
      const args = TaskOnlyParams.parse(rawArgs)
      try {
        return await cancelCodeAudit(args.taskId)
      } catch (error) {
        console.error('[auditedWorkflow] cancelCodeAudit failed unexpectedly:', error)
        return { ok: false, kind: 'codeAudit', reasonCode: 'lock_contended' }
      }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:retryCodeAudit',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowCodeAuditResult> => {
      const args = TaskOnlyParams.parse(rawArgs)
      try {
        return await retryCodeAudit(args.taskId)
      } catch (error) {
        console.error('[auditedWorkflow] retryCodeAudit failed unexpectedly:', error)
        return { ok: false, kind: 'codeAudit', reasonCode: 'lock_contended' }
      }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:requestCodeFix',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowCodeAuditResult> => {
      const args = TaskOnlyParams.parse(rawArgs)
      try {
        return await requestCodeFixAndStart(args.taskId)
      } catch (error) {
        console.error('[auditedWorkflow] requestCodeFix failed unexpectedly:', error)
        return { ok: false, kind: 'codeAudit', reasonCode: 'lock_contended' }
      }
    }
  )
}
