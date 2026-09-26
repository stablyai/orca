import { ipcMain } from 'electron'
import { z } from 'zod'
import type { RecoveryResumeResult } from '../../shared/cross-machine-recovery-descriptor'
import {
  CROSS_MACHINE_RECOVERY_RESUME_LOCAL_CHANNEL,
  type CrossMachineRecoveryResumeLocalArgs
} from '../../shared/cross-machine-recovery-session-ops'
import { RecoveryBindingKeySchema } from '../../shared/rpc-contract/cross-machine-recovery-params'
import { resumeRecoveryBinding } from '../runtime/cross-machine-recovery/recovery-resume'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { isTrustedUIRenderer } from './ui'

const ResumeLocalArgs: z.ZodType<CrossMachineRecoveryResumeLocalArgs> = z
  .object({
    worktreeId: z.string().min(1),
    binding: RecoveryBindingKeySchema
  })
  .strict()

/** Desktop-only channel for the pane's Resume action; it always targets the local runtime. */
export function registerCrossMachineRecoveryLocalHandlers(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler(CROSS_MACHINE_RECOVERY_RESUME_LOCAL_CHANNEL)
  ipcMain.handle(
    CROSS_MACHINE_RECOVERY_RESUME_LOCAL_CHANNEL,
    async (event, args: unknown): Promise<RecoveryResumeResult> => {
      if (!isTrustedUIRenderer(event.sender)) {
        throw new Error('recovery_local_only')
      }
      const parsed = ResumeLocalArgs.safeParse(args)
      if (!parsed.success) {
        throw new Error('invalid_arguments')
      }
      return await resumeRecoveryBinding(runtime, {
        worktree: `id:${parsed.data.worktreeId}`,
        binding: parsed.data.binding,
        presentation: 'focused'
      })
    }
  )
}
