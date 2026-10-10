import { ipcMain } from 'electron'
import { commitChanges } from '../../git/status'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { requireReachableGitRoute } from '../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../shared/execution-host'

export function registerFilesystemGitCommitHandlers(context: FilesystemHandlerContext): void {
  const { store } = context
  ipcMain.handle(
    'git:commit',
    async (
      _event,
      args: { worktreePath: string; message: string; connectionId?: string }
    ): Promise<{ success: boolean; error?: string }> => {
      // Why: validate at the IPC boundary so the renderer gets a clear error instead of an opaque execFile failure.
      if (typeof args.message !== 'string' || args.message.trim().length === 0) {
        throw new Error('Commit message is required')
      }
      const route = requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      if (route.kind === 'ssh') {
        return route.provider.commit(args.worktreePath, args.message)
      }
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
}
