import type { GitCommitAction } from '../../../../shared/git/commands/git-commit-action'
import { applyCommit, recoverSequencer } from '../../../git/worktrees/checkout/commit-actions'
import { createBranch } from '../../../git/worktrees/checkout/create-branch'
import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../../lazy-ipc-handle-group'
import { commitChanges, completeMerge } from '../../../git/source-control/mutations/commit-changes'
import { resolveRegisteredWorktreePath } from '../../worktrees/removal/registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../../worktrees/local-worktree-runtime-options'
import type { FilesystemHandlerContext } from '../filesystem-handler-context'
import { requireReachableGitRoute } from '../../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host/execution-host'

export function registerFilesystemGitCommitHandlers(
  context: FilesystemHandlerContext,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  const { store } = context
  ipc.handle(
    'git:createBranch',
    async (
      _event,
      args: { worktreePath: string; name: string; startPoint: string; connectionId?: string }
    ) => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return createBranch(worktreePath, args.name, args.startPoint, {
        ...getLocalGitOptionsForRegisteredWorktree(store, args.worktreePath, worktreePath),
        admissionTier: 'interactive'
      })
    }
  )
  for (const action of ['abort', 'continue'] as const) {
    const method = action === 'abort' ? 'sequencerAbort' : 'sequencerContinue'
    ipc.handle(
      `git:${method}`,
      async (
        _event,
        args: { worktreePath: string; operation: GitCommitAction; connectionId?: string }
      ) => {
        requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
        const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
        const gitOptions = getLocalGitOptionsForRegisteredWorktree(
          store,
          args.worktreePath,
          worktreePath
        )
        return recoverSequencer(worktreePath, args.operation, action, {
          ...gitOptions,
          admissionTier: 'interactive'
        })
      }
    )
  }
  for (const [method, operation] of [
    ['cherryPick', 'cherry-pick'],
    ['revert', 'revert']
  ] as const) {
    ipc.handle(
      `git:${method}`,
      async (_event, args: { worktreePath: string; commitId: string; connectionId?: string }) => {
        requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
        const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
        const gitOptions = getLocalGitOptionsForRegisteredWorktree(
          store,
          args.worktreePath,
          worktreePath
        )
        return applyCommit(worktreePath, operation, args.commitId, {
          ...gitOptions,
          admissionTier: 'interactive'
        })
      }
    )
  }
  ipc.handle(
    'git:commit',
    async (
      _event,
      args: { worktreePath: string; message: string; connectionId?: string }
    ): Promise<{ success: boolean; error?: string }> => {
      // Validate at IPC so users receive a clear error before process launch.
      if (typeof args.message !== 'string' || args.message.trim().length === 0) {
        throw new Error('Commit message is required')
      }
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return commitChanges(worktreePath, args.message, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )
  ipc.handle(
    'git:completeMerge',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string }
    ): Promise<{ success: boolean; error?: string }> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return completeMerge(worktreePath, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )
}
