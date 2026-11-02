import { ipcMain } from 'electron'
import { awaitWindowsHostGitEnvironmentReady } from '../../git/runner'
import { getRemoteCommitUrl, getRemoteFileUrl } from '../../git/repo'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import { validateFullGitObjectId } from './filesystem-path-containment'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { requireReachableGitRoute } from '../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../shared/execution-host'

export function registerFilesystemGitUrlHandlers(context: FilesystemHandlerContext): void {
  const { store } = context
  ipcMain.handle(
    'git:remoteFileUrl',
    async (
      _event,
      args: {
        worktreePath: string
        relativePath: string
        line: number
        endLine?: number
        connectionId?: string
      }
    ): Promise<string | null> => {
      // Remote URL construction needs the owning SSH host's .git/config.
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await awaitWindowsHostGitEnvironmentReady({ ...gitOptions, cwd: worktreePath })
      return getRemoteFileUrl(worktreePath, args.relativePath, args.line, args.endLine, gitOptions)
    }
  )

  ipcMain.handle(
    'git:remoteCommitUrl',
    async (
      _event,
      args: { worktreePath: string; sha: string; connectionId?: string }
    ): Promise<string | null> => {
      const sha = validateFullGitObjectId(args.sha, 'sha')
      // Remote URL construction needs the owning SSH host's .git/config.
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      await awaitWindowsHostGitEnvironmentReady({ cwd: worktreePath })
      return getRemoteCommitUrl(worktreePath, sha)
    }
  )
}
