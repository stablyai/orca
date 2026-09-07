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
import { checkIgnoredPaths } from '../../git/check-ignored-paths'
import {
  appendFolderToGitignore,
  findKnownHugeFolderPathsToIgnore
} from '../../git/huge-folder-ignore'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../../providers/ssh-git-dispatch'
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
        if (args.connectionId) {
          const provider = getSshGitProvider(args.connectionId)
          if (!provider) {
            throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
          }
          // Why: await keeps the cancellation token registered until the remote request settles (an early finally would free it).
          return await provider.getStatus(args.worktreePath, options)
        }
        const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
        // Why: one registered-worktree lookup feeds both — status polls this
        // handler, and the scan walks every repo's worktree meta.
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

  // Why: parent status reports only one gitlink row per submodule; fetch inner per-file changes from the submodule's own worktree.
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
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getSubmoduleStatus(args.worktreePath, args.submodulePath, args.area)
      }
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
      if (args.connectionId) {
        const paths = args.paths.map((p) => validateGitRelativeFilePath(args.worktreePath, p))
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.checkIgnoredPaths(args.worktreePath, paths)
      }
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

  // Why: backs the SCM "ignore the flooding folder" flow; local-only since huge untracked folders are a local-dev pathology.
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
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getHistory(args.worktreePath, options)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getHistory(worktreePath, { ...options, ...gitOptions })
    }
  )

  // Why: fs-only conflict-state check so non-active worktrees can clear their Rebasing/Merging badges without a full git status.
  ipcMain.handle(
    'git:conflictOperation',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string }
    ): Promise<GitConflictOperation> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.detectConflictOperation(args.worktreePath)
      }
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
    'git:abortMerge',
    async (_event, args: { worktreePath: string; connectionId?: string }): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No git provider for connection "${args.connectionId}"`)
        }
        return provider.abortMerge(args.worktreePath)
      }
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
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No git provider for connection "${args.connectionId}"`)
        }
        return provider.abortRebase(args.worktreePath)
      }
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
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getDiff(
          args.worktreePath,
          args.filePath,
          args.staged,
          args.compareAgainstHead
        )
      }
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
