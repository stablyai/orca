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
import { validateGitRelativeFilePath } from './filesystem-path-containment'
import {
  getLocalGitOptionsForRegisteredWorktree,
  getLocalGitOptionsForRepo,
  getLocalRepoForRegisteredWorktree
} from '../local-worktree-runtime-options'
import { getWorktreeSharedLinkPaths } from '../../git/worktree-shared-directories'
import { applyGitStatusUpstreamRefWatchRequest } from '../git-status-upstream-ref-watch-request'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { readWorktreeGitUnlessWslStopped } from './wsl-gated-worktree-git-read'
import { requireReachableGitRoute } from '../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../shared/execution-host'
import {
  assertWslUncPathRunning,
  noteWslDistroWokenForPath,
  runAsWslUserAct,
  wslDistroForPath
} from '../../wsl/wsl-unc-access-gate'

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
        /** The active workspace's first status: a user act that may start its WSL distro. */
        wakeWslDistro?: boolean
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
        // The active workspace's first status is a user act: it may start its stopped WSL distro.
        const wakeDistro = args.wakeWslDistro
          ? wslDistroForPath(
              args.worktreePath,
              getLocalGitOptionsForRegisteredWorktree(store, args.worktreePath, args.worktreePath)
                .wslDistro
            )
          : null
        const status = await runAsWslUserAct(wakeDistro, async () => {
          // Background poll: its Git or UNC read would boot a stopped WSL distro (E9).
          await assertWslUncPathRunning(args.worktreePath)
          const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
          // Reuse one registered-worktree lookup for frequent status polls and repo metadata reads.
          const repo = getLocalRepoForRegisteredWorktree(store, args.worktreePath, worktreePath)
          const gitOptions = getLocalGitOptionsForRepo(store, repo)
          await assertWslUncPathRunning(worktreePath, gitOptions.wslDistro)
          const sharedLinkPaths = repo ? getWorktreeSharedLinkPaths(repo) : []
          return getStatus(worktreePath, {
            ...options,
            ...gitOptions,
            ...(sharedLinkPaths.length > 0 ? { sharedLinkPaths } : {})
          })
        })
        if (wakeDistro) {
          noteWslDistroWokenForPath(args.worktreePath, wakeDistro)
        }
        return status
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
      // Re-read on every status change: a background poll (E9).
      return readWorktreeGitUnlessWslStopped(
        store,
        args.worktreePath,
        false,
        (worktreePath, gitOptions) =>
          getSubmoduleStatus(worktreePath, args.submodulePath, {
            ...gitOptions,
            ...(args.area === 'staged' ? { staged: true } : {})
          })
      )
    }
  )

  ipcMain.handle(
    'git:checkIgnored',
    async (
      _event,
      args: { worktreePath: string; paths: string[]; connectionId?: string }
    ): Promise<string[]> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      return readWorktreeGitUnlessWslStopped(
        store,
        args.worktreePath,
        false,
        (worktreePath, gitOptions) =>
          checkIgnoredPaths(
            worktreePath,
            args.paths.map((p) => validateGitRelativeFilePath(worktreePath, p)),
            gitOptions
          )
      )
    }
  )

  ipcMain.handle(
    'git:findHugeFoldersToIgnore',
    async (_event, args: { worktreePath: string }): Promise<string[]> =>
      readWorktreeGitUnlessWslStopped(store, args.worktreePath, false, (worktreePath, gitOptions) =>
        findKnownHugeFolderPathsToIgnore(worktreePath, gitOptions)
      )
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
      args: {
        worktreePath: string
        connectionId?: string
        /** Refresh: a user act that may start a stopped WSL distro. */
        wakeWslDistro?: boolean
      } & GitHistoryOptions
    ): Promise<GitHistoryResult> => {
      const options: GitHistoryOptions = { limit: args.limit, baseRef: args.baseRef }
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      return readWorktreeGitUnlessWslStopped(
        store,
        args.worktreePath,
        args.wakeWslDistro,
        (worktreePath, gitOptions) => getHistory(worktreePath, { ...options, ...gitOptions })
      )
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
      // A 3 s poll for inactive worktrees: its UNC reads would boot a stopped WSL distro (E9).
      await assertWslUncPathRunning(args.worktreePath)
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
        oldPath?: string
        connectionId?: string
        /** Showing the diff tab or its Retry: a user act that may start a stopped WSL distro. */
        wakeWslDistro?: boolean
      }
    ): Promise<GitDiffResult> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      return readWorktreeGitUnlessWslStopped(
        store,
        args.worktreePath,
        args.wakeWslDistro,
        (worktreePath, gitOptions) =>
          getDiff(
            worktreePath,
            validateGitRelativeFilePath(worktreePath, args.filePath),
            args.staged,
            args.compareAgainstHead,
            {
              ...gitOptions,
              admissionTier: 'interactive',
              ...(args.oldPath
                ? { oldPath: validateGitRelativeFilePath(worktreePath, args.oldPath) }
                : {})
            }
          )
      )
    }
  )
}
