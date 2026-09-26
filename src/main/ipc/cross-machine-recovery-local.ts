import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { RecoveryResumeResult } from '../../shared/cross-machine-recovery-descriptor'
import {
  CROSS_MACHINE_RECOVERY_RELEASE_LOCAL_CHANNEL,
  CROSS_MACHINE_RECOVERY_RESUME_LOCAL_CHANNEL,
  type CrossMachineRecoveryReleaseLocalResult,
  type CrossMachineRecoveryResumeLocalArgs
} from '../../shared/cross-machine-recovery-session-ops'
import { RecoveryBindingKeySchema } from '../../shared/rpc-contract/cross-machine-recovery-params'
import { releaseRecoveryBindingWithHost } from '../runtime/cross-machine-recovery/recovery-release'
import { resumeRecoveryBinding } from '../runtime/cross-machine-recovery/recovery-resume'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { isTrustedUIRenderer } from './ui'

const ResumeLocalArgs: z.ZodType<CrossMachineRecoveryResumeLocalArgs> = z
  .object({
    worktreeId: z.string().min(1),
    binding: RecoveryBindingKeySchema
  })
  .strict()

function parseLocalArgs(
  event: IpcMainInvokeEvent,
  args: unknown
): CrossMachineRecoveryResumeLocalArgs {
  if (!isTrustedUIRenderer(event.sender)) {
    throw new Error('recovery_local_only')
  }
  const parsed = ResumeLocalArgs.safeParse(args)
  if (!parsed.success) {
    throw new Error('invalid_arguments')
  }
  return parsed.data
}

/** Desktop-only channels for the pane's Resume and Start-shell actions; both target the local runtime. */
export function registerCrossMachineRecoveryLocalHandlers(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler(CROSS_MACHINE_RECOVERY_RESUME_LOCAL_CHANNEL)
  ipcMain.handle(
    CROSS_MACHINE_RECOVERY_RESUME_LOCAL_CHANNEL,
    async (event, args: unknown): Promise<RecoveryResumeResult> => {
      const { worktreeId, binding } = parseLocalArgs(event, args)
      return await resumeRecoveryBinding(runtime, {
        worktree: `id:${worktreeId}`,
        binding,
        presentation: 'focused'
      })
    }
  )
  ipcMain.removeHandler(CROSS_MACHINE_RECOVERY_RELEASE_LOCAL_CHANNEL)
  ipcMain.handle(
    CROSS_MACHINE_RECOVERY_RELEASE_LOCAL_CHANNEL,
    async (event, args: unknown): Promise<CrossMachineRecoveryReleaseLocalResult> => {
      const { worktreeId, binding } = parseLocalArgs(event, args)
      const host = runtime.getCrossMachineRecoveryHost((repoPath) => runtime.addRepo(repoPath))
      const worktree = await host.resolveWorktree(`id:${worktreeId}`)
      return await releaseRecoveryBindingWithHost(host, worktree.id, binding)
    }
  )
}
