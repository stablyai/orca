import { ipcMain } from 'electron'
import type { GitAbortOperationRequest } from '../../../../shared/git/status/git-status-types'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  abortMerge,
  abortRebase
} from '../../../git/source-control/mutations/git-conflict-operation'
import { requireReachableGitRoute } from '../../../providers/execution-host-provider-dispatch'
import { resolveRegisteredWorktreePath } from '../../worktrees/removal/registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../../worktrees/local-worktree-runtime-options'
import type { FilesystemHandlerContext } from '../filesystem-handler-context'

/** Merge and rebase Abort; an expected run identity makes main refuse if the paused run changed. */
export function registerFilesystemGitAbortHandlers(context: FilesystemHandlerContext): void {
  const { store } = context
  ipcMain.handle(
    'git:abortMerge',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string } & GitAbortOperationRequest
    ): Promise<void> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await abortMerge(
        worktreePath,
        { ...gitOptions, admissionTier: 'interactive' },
        { expectedRunIdentity: args.expectedRunIdentity }
      )
    }
  )

  ipcMain.handle(
    'git:abortRebase',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string } & GitAbortOperationRequest
    ): Promise<void> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await abortRebase(
        worktreePath,
        { ...gitOptions, admissionTier: 'interactive' },
        { expectedRunIdentity: args.expectedRunIdentity }
      )
    }
  )
}
