import { ipcMain } from 'electron'
import type {
  ContinueRebaseAction,
  ContinueRebaseRequest,
  ContinueRebaseResult
} from '../../../../shared/git/status/git-status-types'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { readRebaseAutoStash } from '../../../git/source-control/mutations/git-conflict-operation'
import { continueRebase } from '../../../git/source-control/mutations/rebase-continue'
import { requireReachableGitRoute } from '../../../providers/execution-host-provider-dispatch'
import { getLocalGitOptionsForRegisteredWorktree } from '../../worktrees/local-worktree-runtime-options'
import { resolveRegisteredWorktreePath } from '../../worktrees/removal/registered-worktree-roots-cache'
import type { FilesystemHandlerContext } from '../filesystem-handler-context'
import { readWorktreeGitUnlessWslStopped } from './wsl-gated-worktree-git-read'

export function registerFilesystemGitRebaseHandlers({ store }: FilesystemHandlerContext): void {
  ipcMain.handle(
    'git:continueRebase',
    async (
      _event,
      args: {
        worktreePath: string
        connectionId?: string
        action?: ContinueRebaseAction
      } & ContinueRebaseRequest
    ): Promise<ContinueRebaseResult> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      if (args.action === 'inspect') {
        // An automatic read: a stopped WSL distro rejects here and Continue stays disabled.
        return readWorktreeGitUnlessWslStopped(store, args.worktreePath, false, (path, options) =>
          continueRebase(path, 'inspect', { ...options, admissionTier: 'interactive' })
        )
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return continueRebase(worktreePath, 'continue', {
        ...gitOptions,
        admissionTier: 'interactive',
        expected: args.expected
      })
    }
  )

  ipcMain.handle(
    'git:rebaseAutoStash',
    async (_event, args: { worktreePath: string; connectionId?: string }): Promise<boolean> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      // An automatic probe: a stopped WSL distro rejects here and the renderer treats it as off.
      return readWorktreeGitUnlessWslStopped(store, args.worktreePath, false, readRebaseAutoStash)
    }
  )
}
