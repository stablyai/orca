import { ipcMain } from 'electron'
import type { RetryAgentLaunchAction } from '../../../../shared/agent-launch-worktree-recovery'
import type { WorktreeIpcContext } from '../worktree-ipc-context'

export function registerAgentLaunchRecoveryHandlers({ runtime }: WorktreeIpcContext): void {
  ipcMain.handle(
    'worktrees:retryAgentLaunch',
    (_event, args: {
      worktreeId: string
      expectedFailureId: string
      clientMutationId: string
      action: RetryAgentLaunchAction
    }) =>
      runtime.retryWorktreeAgentLaunch(
        `id:${args.worktreeId}`,
        {
          expectedFailureId: args.expectedFailureId,
          clientMutationId: args.clientMutationId,
          action: args.action
        },
        undefined
      )
  )
  ipcMain.handle(
    'worktrees:forgetAgentLaunch',
    (_event, args: { worktreeId: string; expectedOperationId: string; clientMutationId: string }) =>
      runtime.forgetUnknownWorktreeAgentLaunch(
        `id:${args.worktreeId}`,
        {
          expectedOperationId: args.expectedOperationId,
          clientMutationId: args.clientMutationId
        },
        undefined
      )
  )
  ipcMain.handle('worktrees:retryBackgroundAgentLaunch', (_event, args) =>
    runtime.retryBackgroundAgentLaunch(args, undefined)
  )
  ipcMain.handle('worktrees:forgetBackgroundAgentLaunch', (_event, args) =>
    runtime.forgetBackgroundAgentLaunch(args, undefined)
  )
  ipcMain.handle('worktrees:pendingAgentLaunchSummary', () =>
    runtime.pendingAgentLaunchSummary(undefined)
  )
  ipcMain.handle('worktrees:unknownAgentLaunchSiblingCount', (_event, args: { worktreeId: string }) =>
    runtime
      .unknownWorktreeAgentLaunchSiblingCount(`id:${args.worktreeId}`, undefined)
      .then((count) => ({ count }))
  )
  ipcMain.handle('worktrees:forgetUnknownAgentLaunchSiblings', (_event, args: { worktreeId: string }) =>
    runtime.forgetUnknownWorktreeAgentLaunchSiblings(`id:${args.worktreeId}`, undefined)
  )
}
