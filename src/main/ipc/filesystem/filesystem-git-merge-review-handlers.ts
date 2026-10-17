import { ipcMain } from 'electron'
import {
  acceptWorktreeMerge,
  getWorktreeMergeReviewState,
  rejectWorktreeMerge,
  resolveMainWorktreePath,
  syncWorktreeToMain,
  type WorktreeMergeReviewGitOptions
} from '../../git/worktree-merge-review'
import type {
  WorktreeMergeReviewAcceptOutcome,
  WorktreeMergeReviewRejectOutcome,
  WorktreeMergeReviewState,
  WorktreeMergeReviewSyncOutcome
} from '../../../shared/git-merge-review'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { requireReachableGitRoute } from '../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../shared/execution-host'

type MergeReviewTarget = {
  worktreePath: string
  mainWorktreePath: string
  gitOptions: WorktreeMergeReviewGitOptions
}

/**
 * Shared prologue: authorize the route, authorize the path, and resolve the main
 * checkout the operation actually acts on.
 *
 * Why the main checkout is derived here rather than sent by the renderer: every
 * one of these operations writes to it, so a renderer-supplied path would be an
 * unvalidated write target.
 */
async function resolveMergeReviewTarget(
  context: FilesystemHandlerContext,
  args: { worktreePath: string; connectionId?: string }
): Promise<MergeReviewTarget> {
  requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
  const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, context.store)
  const gitOptions = getLocalGitOptionsForRegisteredWorktree(
    context.store,
    args.worktreePath,
    worktreePath
  )
  return {
    worktreePath,
    mainWorktreePath: await resolveMainWorktreePath(worktreePath, gitOptions),
    gitOptions
  }
}

export function registerFilesystemGitMergeReviewHandlers(context: FilesystemHandlerContext): void {
  ipcMain.handle(
    'git:worktreeMergeReviewState',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string }
    ): Promise<WorktreeMergeReviewState> => {
      const target = await resolveMergeReviewTarget(context, args)
      return getWorktreeMergeReviewState(target.mainWorktreePath, target.gitOptions)
    }
  )

  ipcMain.handle(
    'git:worktreeMergeReviewSync',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string }
    ): Promise<WorktreeMergeReviewSyncOutcome> => {
      const target = await resolveMergeReviewTarget(context, args)
      return syncWorktreeToMain(
        { worktreePath: target.worktreePath, mainWorktreePath: target.mainWorktreePath },
        target.gitOptions
      )
    }
  )

  ipcMain.handle(
    'git:worktreeMergeReviewAccept',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string; message?: string }
    ): Promise<WorktreeMergeReviewAcceptOutcome> => {
      const target = await resolveMergeReviewTarget(context, args)
      return acceptWorktreeMerge(
        target.mainWorktreePath,
        target.gitOptions,
        typeof args.message === 'string' && args.message.trim() ? args.message : undefined
      )
    }
  )

  ipcMain.handle(
    'git:worktreeMergeReviewReject',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string; assumeYes?: boolean }
    ): Promise<WorktreeMergeReviewRejectOutcome> => {
      const target = await resolveMergeReviewTarget(context, args)
      return rejectWorktreeMerge(
        target.mainWorktreePath,
        target.gitOptions,
        args.assumeYes === true
      )
    }
  )
}
