import { ipcMain } from 'electron'
import { awaitWindowsHostGitEnvironmentReady } from '../../git/runner'
import { getRemoteCommitUrl, getRemoteFileUrl } from '../../git/repo'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../../providers/ssh-git-dispatch'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { validateFullGitObjectId } from '../filesystem-path-containment'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

export function registerFilesystemGitUrlHandlers(context: FilesystemHandlerContext): void {
  const { store } = context
  ipcMain.handle(
    'git:remoteFileUrl',
    async (
      _event,
      args: { worktreePath: string; relativePath: string; line: number; connectionId?: string }
    ): Promise<string | null> => {
      // Why: remote repos can't read relay-side .git/config locally; delegate URL construction to the SSH provider.
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getRemoteFileUrl(args.worktreePath, args.relativePath, args.line)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      await awaitWindowsHostGitEnvironmentReady({ cwd: worktreePath })
      return getRemoteFileUrl(worktreePath, args.relativePath, args.line)
    }
  )

  ipcMain.handle(
    'git:remoteCommitUrl',
    async (
      _event,
      args: { worktreePath: string; sha: string; connectionId?: string }
    ): Promise<string | null> => {
      const sha = validateFullGitObjectId(args.sha, 'sha')
      // Why: remote repos can't read relay-side .git/config locally; delegate URL construction to the SSH provider.
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getRemoteCommitUrl(args.worktreePath, sha)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      await awaitWindowsHostGitEnvironmentReady({ cwd: worktreePath })
      return getRemoteCommitUrl(worktreePath, sha)
    }
  )
}
