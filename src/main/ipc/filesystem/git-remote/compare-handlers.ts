import { ipcMain } from 'electron'
import type {
  GitBranchCompareResult,
  GitCommitCompareResult
} from '../../../../shared/git-diff-compare-types'
import { getBranchCompare, getCommitCompare } from '../../../git/status'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../../../providers/ssh-git-dispatch'
import { resolveRegisteredWorktreePath } from '../../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../../local-worktree-runtime-options'
import { validateFullGitObjectId } from '../../filesystem-path-containment'
import type { FilesystemHandlerContext } from '../filesystem-handler-context'
import type { GitAdmissionTier } from '../../../git/command-runner/git-exec-options'

export function registerGitRemoteCompareHandlers(context: FilesystemHandlerContext): void {
  const { store } = context

  ipcMain.handle(
    'git:branchCompare',
    async (
      _event,
      args: {
        worktreePath: string
        baseRef: string
        connectionId?: string
        admissionTier?: GitAdmissionTier
      }
    ): Promise<GitBranchCompareResult> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return args.admissionTier
          ? provider.getBranchCompare(args.worktreePath, args.baseRef, {
              admissionTier: args.admissionTier
            })
          : provider.getBranchCompare(args.worktreePath, args.baseRef)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getBranchCompare(worktreePath, args.baseRef, {
        ...gitOptions,
        ...(args.admissionTier ? { admissionTier: args.admissionTier } : {})
      })
    }
  )

  ipcMain.handle(
    'git:commitCompare',
    async (
      _event,
      args: { worktreePath: string; commitId: string; connectionId?: string }
    ): Promise<GitCommitCompareResult> => {
      const commitId = validateFullGitObjectId(args.commitId, 'commitId')
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getCommitCompare(args.worktreePath, commitId)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getCommitCompare(worktreePath, commitId, gitOptions)
    }
  )
}
