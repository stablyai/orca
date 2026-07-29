// Developer-only manual state-machine transition control (plan §15, Phase 1).
// Callers MUST check `!app.isPackaged` before calling registerAuditedWorkflowDevTransitionHandlers
// — see register-core-handlers.ts. In a packaged build this module is imported
// but its register function is never invoked, so the IPC channel never exists
// and an invoke rejects with "no handler registered" rather than a disabled
// no-op. This is a permanent property of the feature, re-asserted in every
// later phase, not a Phase-1-only convenience.
import { ipcMain } from 'electron'
import { z } from 'zod'
import { applyDevTransition, getTaskProjection } from '../audited-workflow/audited-task-service'
import { broadcastAuditedTaskChanged } from '../audited-workflow/audited-workflow-broadcast'
import { AUDITED_TASK_STATES } from '../../shared/audited-workflow-types'
import type {
  AuditedWorkflowDevTransitionParams,
  AuditedWorkflowDevTransitionResult
} from '../../shared/audited-workflow-types'
import type { AuditedTransitionCommand } from '../audited-workflow/audited-workflow-state-machine'

const DEV_TRANSITION_COMMANDS = [
  'select',
  'triage',
  'triageAutoPlan',
  'triageAutoDirect',
  'triageBlock',
  'planComplete',
  'planReviewApprove',
  'planReviewFixesRequested',
  'planReviewBlock',
  'revisePlan',
  'implement',
  'implementComplete',
  'implementBlock',
  'codeAuditApprove',
  'codeAuditFixesRequested',
  'codeAuditBlock',
  'fix',
  'commitAuthorize',
  'commitComplete',
  'commitBlock',
  'land',
  'landSucceed',
  'landRefuse',
  'blockFromInvariantViolation',
  'retry',
  'resumeAttempt',
  'cancel'
] as const satisfies readonly AuditedTransitionCommand[]

const DevTransitionParams = z.object({
  taskId: z.string().min(1),
  command: z.enum(DEV_TRANSITION_COMMANDS)
})

export function registerAuditedWorkflowDevTransitionHandlers(): void {
  ipcMain.handle(
    'auditedWorkflow:devTransition',
    (_event, rawArgs: unknown): AuditedWorkflowDevTransitionResult => {
      const args = DevTransitionParams.parse(rawArgs)
      const command: AuditedTransitionCommand = args.command
      const result = applyDevTransition(args.taskId, command)
      if (result.applied) {
        const projection = getTaskProjection(args.taskId)
        if (projection) {
          broadcastAuditedTaskChanged(projection)
        }
        return { applied: true }
      }
      return { applied: false, reasonCode: result.reasonCode }
    }
  )
}

export type { AuditedWorkflowDevTransitionParams }
export { AUDITED_TASK_STATES }
