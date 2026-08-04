// IPC surface for the Phase 10 landing lane. Split from ipc/audited-workflow.ts
// so that file stays within its line budget without a max-lines suppression.
//
// Electron-IPC only: no RPC method is registered for any audited-workflow
// channel, and the mobile allowlist test enforces that.
//
// THE RENDERER SUPPLIES ONLY A taskId. There is no sha, branch, path, or base
// commit parameter: landing identity is read from durable state inside the
// admission transaction, never echoed back from the client, and an outcome is
// never dictated by the caller.
import { ipcMain } from 'electron'
import { z } from 'zod'
import type {
  AuditedWorkflowLandResult,
  AuditedWorkflowRecheckLandResult
} from '../../shared/audited-workflow-command-types'
import { recheckLand, startLand } from '../audited-workflow/audited-land-orchestration'

// Why .strict(): an extra sha/branch/path key must be REJECTED, not silently
// stripped — the renderer must never influence landing identity, and a stripped
// key would hide a caller bug.
const TaskOnlyParams = z.object({ taskId: z.string().min(1) }).strict()

export function registerAuditedWorkflowLandHandlers(): void {
  ipcMain.handle(
    'auditedWorkflow:land',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowLandResult> => {
      const args = TaskOnlyParams.parse(rawArgs)
      try {
        return await startLand(args.taskId)
      } catch (error) {
        // The raw error stays local — never projected, and never carrying a
        // source repo path, argv, or Git stderr.
        console.error('[auditedWorkflow] land failed unexpectedly:', error)
        return { ok: false, kind: 'landing', reasonCode: 'lock_contended' }
      }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:recheckLand',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowRecheckLandResult> => {
      const args = TaskOnlyParams.parse(rawArgs)
      try {
        return await recheckLand(args.taskId)
      } catch (error) {
        console.error('[auditedWorkflow] recheckLand failed unexpectedly:', error)
        return { ok: false, kind: 'landing', reasonCode: 'lock_contended' }
      }
    }
  )
}
