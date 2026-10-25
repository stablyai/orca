import { ipcMain } from 'electron'
import type {
  GitConflictOperation,
  GitStagingArea,
  GitStatusResult
} from '../../../shared/git-status-types'
import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import type { GitHistoryOptions, GitHistoryResult } from '../../../shared/git-history'
import type { GitStatusUpstreamRefWatchRequest } from '../git-status-upstream-ref-watch-request'
import type { GitAdmissionTier } from '../../git/command-runner/git-exec-options'
import {
  getStatus,
  getSubmoduleStatus,
  abortMerge,
  abortRebase,
  detectConflictOperation,
  getDiff
} from '../../git/status'
import { getHistory } from '../../git/history'
import { isGitWorktreeMutationInFlight } from '../../git/git-worktree-mutation-state'
import type { GitMutationInFlight } from '../../../shared/git-mutation-in-flight'
import { checkIgnoredPaths } from '../../git/check-ignored-paths'
import {
  appendFolderToGitignore,
  findKnownHugeFolderPathsToIgnore
} from '../../git/huge-folder-ignore'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { validateGitRelativeFilePath } from '../filesystem-path-containment'
import {
  getLocalGitOptionsForRegisteredWorktree,
  getLocalGitOptionsForRepo,
  getLocalRepoForRegisteredWorktree
} from '../local-worktree-runtime-options'
import { getWorktreeSharedLinkPaths } from '../../git/worktree-shared-directories'
import { applyGitStatusUpstreamRefWatchRequest } from '../git-status-upstream-ref-watch-request'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { requireReachableGitRoute } from '../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../shared/execution-host'

export function registerFilesystemGitStatusHandlers(context: FilesystemHandlerContext): void {
  const { store, gitStatusCancellations } = context
  ipcMain.handle(
    'git:status',
    async (
      event,
      args: {
        worktreePath: string
        connectionId?: string
        admissionTier?: GitAdmissionTier
        includeIgnored?: boolean
        includeLineStats?: boolean
        bypassEffectiveUpstreamNegativeCache?: boolean
        reuseLineStats?: boolean
        branchLineTotalMergeBase?: string
        requestToken?: string
      }
    ): Promise<GitStatusResult> => {
      const controller = gitStatusCancellations.begin(event, args.requestToken)
      const options = {
        includeIgnored: args.includeIgnored ?? false,
        admissionTier: args.admissionTier ?? ('status' as const),
        ...(args.includeLineStats === false ? { includeLineStats: false } : {}),
        ...(args.reuseLineStats === true ? { reuseLineStats: true } : {}),
        ...(args.branchLineTotalMergeBase === undefined
          ? {}
          : { branchLineTotalMergeBase: args.branchLineTotalMergeBase }),
        ...(args.bypassEffectiveUpstreamNegativeCache === true
          ? { bypassEffectiveUpstreamNegativeCache: true }
          : {}),
        ...(controller ? { signal: controller.signal } : {})
      }
      try {
        requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
        const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
        // Reuse one registered-worktree lookup for frequent status polls and repo metadata reads.
        const repo = getLocalRepoForRegisteredWorktree(store, args.worktreePath, worktreePath)
        const gitOptions = getLocalGitOptionsForRepo(store, repo)
        const sharedLinkPaths = repo ? getWorktreeSharedLinkPaths(repo) : []
        return await getStatus(worktreePath, {
          ...options,
          ...gitOptions,
          ...(sharedLinkPaths.length > 0 ? { sharedLinkPaths } : {})
        })
      } finally {
        gitStatusCancellations.finish(event, args.requestToken, controller)
      }
    }
  )

  ipcMain.handle('git:cancelStatus', (event, args: { requestToken: string }): void => {
    gitStatusCancellations.cancel(event, args.requestToken)
  })

  ipcMain.handle(
    'git:setStatusUpstreamRefWatch',
    (_event, args: GitStatusUpstreamRefWatchRequest): Promise<void> =>
      applyGitStatusUpstreamRefWatchRequest(store, args)
  )

  // Parent status exposes only gitlinks; read inner changes from each submodule worktree.
  ipcMain.handle(
    'git:submoduleStatus',
    async (
      _event,
      args: {
        worktreePath: string
        submodulePath: string
        connectionId?: string
        area?: GitStagingArea
      }
    ): Promise<GitStatusResult> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getSubmoduleStatus(worktreePath, args.submodulePath, {
        ...gitOptions,
        ...(args.area === 'staged' ? { staged: true } : {})
      })
    }
  )

  ipcMain.handle(
    'git:checkIgnored',
    async (
      _event,
      args: { worktreePath: string; paths: string[]; connectionId?: string }
    ): Promise<string[]> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const paths = args.paths.map((p) => validateGitRelativeFilePath(worktreePath, p))
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return checkIgnoredPaths(worktreePath, paths, gitOptions)
    }
  )

  ipcMain.handle(
    'git:findHugeFoldersToIgnore',
    async (_event, args: { worktreePath: string }): Promise<string[]> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return findKnownHugeFolderPathsToIgnore(worktreePath, gitOptions)
    }
  )

  ipcMain.handle(
    'git:appendGitignore',
    async (_event, args: { worktreePath: string; folderName: string }): Promise<boolean> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return appendFolderToGitignore(worktreePath, args.folderName)
    }
  )

  ipcMain.handle(
    'git:history',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string } & GitHistoryOptions
    ): Promise<GitHistoryResult> => {
      const options: GitHistoryOptions = { limit: args.limit, baseRef: args.baseRef }
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getHistory(worktreePath, { ...options, ...gitOptions })
    }
  )

  // Filesystem probes clear inactive-worktree conflict badges without a full Git status.
  ipcMain.handle(
    'git:conflictOperation',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string }
    ): Promise<GitConflictOperation> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return detectConflictOperation(worktreePath, gitOptions)
    }
  )

  ipcMain.handle(
    'git:mutationInFlight',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string }
    ): Promise<GitMutationInFlight> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return { inFlight: await isGitWorktreeMutationInFlight(worktreePath, gitOptions) }
    }
  )

  ipcMain.handle(
    'git:abortMerge',
    async (_event, args: { worktreePath: string; connectionId?: string }): Promise<void> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await abortMerge(worktreePath, { ...gitOptions, admissionTier: 'interactive' })
    }
  )

  ipcMain.handle(
    'git:abortRebase',
    async (_event, args: { worktreePath: string; connectionId?: string }): Promise<void> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await abortRebase(worktreePath, { ...gitOptions, admissionTier: 'interactive' })
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
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
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
