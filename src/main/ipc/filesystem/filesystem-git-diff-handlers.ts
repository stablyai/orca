import { ipcMain } from 'electron'
import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import { getBranchDiff, getCommitDiff } from '../../git/status'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import {
  validateFullGitObjectId,
  validateGitRelativeFilePath
} from '../filesystem-path-containment'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { requireReachableGitRoute } from '../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../shared/execution-host'

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
      const route = requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      if (route.kind === 'ssh') {
        const results = await route.provider.getBranchDiff(
          args.worktreePath,
          args.compare.mergeBase,
          {
            includePatch: true,
            headOid: args.compare.headOid,
            filePath: args.filePath,
            oldPath: args.oldPath
          }
        )
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
      const route = requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      if (route.kind === 'ssh') {
        return route.provider.getCommitDiff(args.worktreePath, {
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
}
