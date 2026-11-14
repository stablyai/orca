import { ipcMain } from 'electron'
import { readWorktreeAtRiskLocalFiles } from '../../git/worktrees/removal/worktree-at-risk-local-files'
import type { WorktreeAtRiskLocalFiles } from '../../../shared/worktree/removal/at-risk-local-files'
import { getLocalRepoForRegisteredWorktree } from '../local-worktree-runtime-options'
import { requireReachableGitRoute } from '../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../shared/execution-host'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { readWorktreeGitUnlessWslStopped } from './wsl-gated-worktree-git-read'

/** Delete-preview ignored-file scans; a closed or retargeted preview cancels its queued or running scan. */
export function registerFilesystemGitAtRiskLocalFilesHandlers(
  context: FilesystemHandlerContext
): void {
  // Request tokens are unique per scan, so these share the sender-scoped status registry.
  const { store, gitStatusCancellations: cancellations } = context
  ipcMain.handle(
    'git:atRiskLocalFiles',
    async (
      event,
      args: {
        worktreePath: string
        connectionId?: string
        requestToken?: string
      }
    ): Promise<WorktreeAtRiskLocalFiles> => {
      const controller = cancellations.begin(event, args.requestToken)
      try {
        requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
        return await readWorktreeGitUnlessWslStopped(
          store,
          args.worktreePath,
          false,
          (worktreePath, gitOptions) =>
            readWorktreeAtRiskLocalFiles({
              worktreePath,
              mainCheckoutPath:
                getLocalRepoForRegisteredWorktree(store, args.worktreePath, worktreePath)?.path ??
                null,
              gitOptions: controller ? { ...gitOptions, signal: controller.signal } : gitOptions
            })
        )
      } finally {
        cancellations.finish(event, args.requestToken, controller)
      }
    }
  )

  ipcMain.handle('git:cancelAtRiskLocalFiles', (event, args: { requestToken: string }): void => {
    cancellations.cancel(event, args.requestToken)
  })
}
