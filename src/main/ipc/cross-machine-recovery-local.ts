import { ipcMain } from 'electron'
import type { RecoveryResumeResult } from '../../shared/cross-machine-recovery-descriptor'
import {
  CROSS_MACHINE_RECOVERY_RESUME_LOCAL_CHANNEL,
  type CrossMachineRecoveryResumeLocalArgs
} from '../../shared/cross-machine-recovery-session-ops'
import { resumeRecoveryBinding } from '../runtime/cross-machine-recovery/recovery-resume'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { isTrustedUIRenderer } from './ui'

function isResumeLocalArgs(value: unknown): value is CrossMachineRecoveryResumeLocalArgs {
  return (
    typeof value === 'object' &&
    value !== null &&
    'worktreeId' in value &&
    typeof value.worktreeId === 'string' &&
    value.worktreeId.length > 0 &&
    'providerSessionId' in value &&
    typeof value.providerSessionId === 'string' &&
    value.providerSessionId.length > 0
  )
}

/** Desktop-only channel for the pane's Resume action; it always targets the local runtime. */
export function registerCrossMachineRecoveryLocalHandlers(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler(CROSS_MACHINE_RECOVERY_RESUME_LOCAL_CHANNEL)
  ipcMain.handle(
    CROSS_MACHINE_RECOVERY_RESUME_LOCAL_CHANNEL,
    async (event, args: unknown): Promise<RecoveryResumeResult> => {
      if (!isTrustedUIRenderer(event.sender)) {
        throw new Error('recovery_local_only')
      }
      if (!isResumeLocalArgs(args)) {
        throw new Error('invalid_arguments')
      }
      return await resumeRecoveryBinding(runtime, {
        worktree: `id:${args.worktreeId}`,
        providerSessionId: args.providerSessionId,
        presentation: 'focused'
      })
    }
  )
}
