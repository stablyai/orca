import { ipcMain } from 'electron'
import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import { getBranchDiff, getCommitDiff, getDiff } from '../../git/status'
import { getPerforceFolderDiff } from '../../perforce/perforce-diff-routing'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../../providers/ssh-git-dispatch'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import {
  validateFullGitObjectId,
  validateGitRelativeFilePath
} from '../filesystem-path-containment'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

export function registerFilesystemGitDiffHandlers(context: FilesystemHandlerContext): void {
  const { store } = context
  ipcMain.handle(
    'git:branchDiff',
    async (
      _event,
      args: {
        worktreePath: string
        compare: {
          baseRef: string
          baseOid: string
          headOid: string
          mergeBase: string
        }
        filePath: string
        oldPath?: string
        connectionId?: string
      }
    ): Promise<GitDiffResult> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        const results = await provider.getBranchDiff(args.worktreePath, args.compare.mergeBase, {
          includePatch: true,
          headOid: args.compare.headOid,
          filePath: args.filePath,
          oldPath: args.oldPath
        })
        return (
          results[0] ?? {
            kind: 'text',
            originalContent: '',
            modifiedContent: '',
            originalIsBinary: false,
            modifiedIsBinary: false
          }
        )
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      const oldPath = args.oldPath
        ? validateGitRelativeFilePath(worktreePath, args.oldPath)
        : undefined
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getBranchDiff(
        worktreePath,
        {
          mergeBase: args.compare.mergeBase,
          headOid: args.compare.headOid,
          filePath,
          oldPath
        },
        { ...gitOptions, admissionTier: 'interactive' }
      )
    }
  )

  ipcMain.handle(
    'git:commitDiff',
    async (
      _event,
      args: {
        worktreePath: string
        commitOid: string
        parentOid?: string | null
        filePath: string
        oldPath?: string
        connectionId?: string
      }
    ): Promise<GitDiffResult> => {
      const commitOid = validateFullGitObjectId(args.commitOid, 'commitOid')
      const parentOid = args.parentOid ? validateFullGitObjectId(args.parentOid, 'parentOid') : null
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getCommitDiff(args.worktreePath, {
          commitOid,
          parentOid,
          filePath: args.filePath,
          oldPath: args.oldPath
        })
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      const oldPath = args.oldPath
        ? validateGitRelativeFilePath(worktreePath, args.oldPath)
        : undefined
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getCommitDiff(
        worktreePath,
        {
          commitOid,
          parentOid,
          filePath,
          oldPath
        },
        { ...gitOptions, admissionTier: 'interactive' }
      )
    }
  )

  ipcMain.handle(
    'git:diff',
    async (
      _event,
      args: {
        worktreePath: string
        filePath: string
        staged: boolean
        compareAgainstHead?: boolean
        connectionId?: string
      }
    ): Promise<GitDiffResult> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        const p4Diff = await getPerforceFolderDiff(
          store,
          args.connectionId,
          args.worktreePath,
          args.filePath
        )
        return (
          p4Diff ??
          provider.getDiff(args.worktreePath, args.filePath, args.staged, args.compareAgainstHead)
        )
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      const p4Diff = await getPerforceFolderDiff(store, null, worktreePath, filePath)
      if (p4Diff) {
        return p4Diff
      }
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getDiff(worktreePath, filePath, args.staged, args.compareAgainstHead, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )
}
