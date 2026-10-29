import { ipcMain } from 'electron'
import { posix, resolve } from 'node:path'
import type {
  CreateHostedReviewArgs,
  CreateStackedHostedReviewArgs,
  HostedReviewCreationEligibilityArgs,
  HostedReviewForBranchArgs
} from '../../shared/hosted-review'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import {
  createHostedReview,
  getHostedReviewCreationEligibility
} from '../source-control/hosted-review-creation'
import { createStackedHostedReview } from '../source-control/stacked-hosted-review-creation'
import { getHostedReviewForBranch } from '../source-control/hosted-review'
import { resolveRegisteredWorktreePath } from './registered-worktree-roots-cache'
import { listRepoWorktreeGraph } from '../repo-worktrees'
import {
  getLocalProjectGhExecOptions,
  getLocalProjectWorktreeGitOptions
} from '../project-runtime-git-options'
import { getWorktreeSharedLinkPaths } from '../git/worktree-shared-directories'
import { getRepoExecutionHostId, getRepoSshConnectionId } from '../../shared/execution-host'
import { getStoredRepoExecutionHostId } from '../repo-execution-host'
import { guardWslUncPathAccess } from '../wsl/wsl-unc-access-gate'

function assertRegisteredRepo(repoPath: string, store: Store, repoId?: string): Repo {
  if (repoId) {
    const repo = store.getRepo(repoId)
    if (!repo || repo.path !== repoPath) {
      throw new Error('Access denied: unknown repository')
    }
    return repo
  }
  const resolvedRepoPath = resolve(repoPath)
  const repo = store.getRepos().find((r) => resolve(r.path) === resolvedRepoPath)
  if (!repo) {
    throw new Error('Access denied: unknown repository path')
  }
  return repo
}

function assertRegisteredRepoForBranch(args: HostedReviewForBranchArgs, store: Store): Repo {
  if (!args.repoOwnerExecutionHostId) {
    return assertRegisteredRepo(args.repoPath, store, args.repoId)
  }
  const matches = store.getRepos().filter((candidate) => {
    // Check filesystem ownership, not dialability, before applying local path rules.
    const samePath = getRepoSshConnectionId(candidate)
      ? normalizeRemoteHostedReviewPath(candidate.path) ===
        normalizeRemoteHostedReviewPath(args.repoPath)
      : resolve(candidate.path) === resolve(args.repoPath)
    return (
      candidate.id === args.repoId &&
      samePath &&
      getRepoExecutionHostId(candidate) === args.repoOwnerExecutionHostId
    )
  })
  if (matches.length !== 1) {
    throw new Error('Access denied: unknown or ambiguous repository owner')
  }
  return matches[0]
}

async function resolveHostedReviewWorktreePath(
  repo: Repo,
  store: Store,
  worktreePath?: string
): Promise<string> {
  if (!worktreePath) {
    return repo.path
  }
  if (getRepoSshConnectionId(repo)) {
    const remoteWorktreePath = normalizeRemoteHostedReviewPath(worktreePath)
    const repoWorktrees = await listRepoWorktreeGraph(repo)
    if (
      !repoWorktrees.some(
        (worktree) => normalizeRemoteHostedReviewPath(worktree.path) === remoteWorktreePath
      )
    ) {
      throw new Error('Access denied: worktree does not belong to repository')
    }
    return remoteWorktreePath
  }
  const resolvedWorktreePath = await resolveRegisteredWorktreePath(worktreePath, store)
  const localGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  const repoWorktrees =
    Object.keys(localGitOptions).length > 0
      ? await listRepoWorktreeGraph(repo, localGitOptions)
      : await listRepoWorktreeGraph(repo)
  if (!repoWorktrees.some((worktree) => resolve(worktree.path) === resolvedWorktreePath)) {
    throw new Error('Access denied: worktree does not belong to repository')
  }
  return resolvedWorktreePath
}

function normalizeRemoteHostedReviewPath(remotePath: string): string {
  if (!remotePath || remotePath.includes('\0')) {
    throw new Error('Access denied: invalid worktree path')
  }
  // Remote paths use POSIX rules; Windows resolve would rewrite their identity.
  const normalized = posix.normalize(remotePath)
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

export function registerHostedReviewHandlers(store: Store, stats: StatsCollector): void {
  ipcMain.handle('hostedReview:forBranch', async (_event, args: HostedReviewForBranchArgs) => {
    const repo = assertRegisteredRepoForBranch(args, store)
    const localGitOptions = {
      ...getLocalProjectGhExecOptions(store, repo),
      admissionTier: args.admissionTier ?? ('background' as const)
    }
    // Sidebar cards and the checks panel poll this for every provider; gh/glab in WSL boot it (E9).
    // Only an explicit Refresh may start a stopped distro; admissionTier is priority only, and
    // the visible scheduler sends 'interactive' for the selected card on a timer.
    const review = await guardWslUncPathAccess(
      repo.path,
      () =>
        getHostedReviewForBranch({
          repoPath: repo.path,
          executionHostId: getStoredRepoExecutionHostId(repo),
          branch: args.branch,
          linkedGitHubPR: args.linkedGitHubPR ?? null,
          fallbackGitHubPR: args.linkedGitHubPR == null ? (args.fallbackGitHubPR ?? null) : null,
          linkedGitLabMR: args.linkedGitLabMR ?? null,
          linkedBitbucketPR: args.linkedBitbucketPR ?? null,
          linkedAzureDevOpsPR: args.linkedAzureDevOpsPR ?? null,
          linkedGiteaPR: args.linkedGiteaPR ?? null,
          currentHeadOid: args.currentHeadOid ?? null,
          ...(args.active === true ? { active: true } : {}),
          ...(args.force === true ? { force: true } : {}),
          localGitExecOptions: localGitOptions
        }),
      { wake: args.wakeWslDistro === true, wslDistro: localGitOptions.wslDistro }
    )
    if (review?.provider === 'github' && !stats.hasCountedPR(review.url)) {
      stats.record({
        type: 'pr_created',
        at: Date.now(),
        repoId: repo.id,
        meta: { prNumber: review.number, prUrl: review.url }
      })
    }
    return review
  })

  ipcMain.handle(
    'hostedReview:getCreationEligibility',
    async (_event, args: HostedReviewCreationEligibilityArgs) => {
      const repo = assertRegisteredRepo(args.repoPath, store, args.repoId)
      const localGitOptions = getLocalProjectGhExecOptions(store, repo)
      // Source Control asks on mount; only the user's Create PR may start a stopped distro (E9).
      return guardWslUncPathAccess(
        repo.path,
        async () => {
          const worktreePath = await resolveHostedReviewWorktreePath(repo, store, args.worktreePath)
          return getHostedReviewCreationEligibility({
            ...args,
            repoPath: worktreePath,
            executionHostId: getStoredRepoExecutionHostId(repo),
            localGitExecOptions: { ...localGitOptions, admissionTier: 'interactive' as const }
          })
        },
        { wake: args.wakeWslDistro === true, wslDistro: localGitOptions.wslDistro }
      )
    }
  )

  ipcMain.handle('hostedReview:create', async (_event, args: CreateHostedReviewArgs) => {
    const repo = assertRegisteredRepo(args.repoPath, store, args.repoId)
    const worktreePath = await resolveHostedReviewWorktreePath(repo, store, args.worktreePath)
    const localGitOptions = {
      ...getLocalProjectGhExecOptions(store, repo),
      admissionTier: 'interactive' as const
    }
    // Exclude Orca-owned symlinks from local dirty checks; remote paths must never read or cache unrelated local orca.yaml files (#10451).
    const sharedLinkPaths = getRepoSshConnectionId(repo) ? [] : getWorktreeSharedLinkPaths(repo)
    const executionOptions =
      Object.keys(localGitOptions).length > 0 || sharedLinkPaths.length > 0
        ? {
            ...(Object.keys(localGitOptions).length > 0
              ? { localGitExecOptions: localGitOptions }
              : {}),
            ...(sharedLinkPaths.length > 0 ? { sharedLinkPaths } : {})
          }
        : undefined
    const input = {
      provider: args.provider,
      base: args.base,
      head: args.head,
      title: args.title,
      body: args.body,
      draft: args.draft,
      ...(args.useTemplate !== undefined ? { useTemplate: args.useTemplate } : {})
    }
    const executionHostId = getStoredRepoExecutionHostId(repo)
    const result = executionOptions
      ? await createHostedReview(worktreePath, input, executionHostId, executionOptions)
      : await createHostedReview(worktreePath, input, executionHostId)
    if (result.ok && !stats.hasCountedPR(result.url)) {
      stats.record({
        type: 'pr_created',
        at: Date.now(),
        repoId: repo.id,
        meta: { prNumber: result.number, prUrl: result.url }
      })
    }
    return result
  })

  ipcMain.handle(
    'hostedReview:createStacked',
    async (_event, args: CreateStackedHostedReviewArgs) => {
      const repo = assertRegisteredRepo(args.repoPath, store, args.repoId)
      const worktreePath = await resolveHostedReviewWorktreePath(repo, store, args.worktreePath)
      const localGitOptions = {
        ...getLocalProjectGhExecOptions(store, repo),
        admissionTier: 'interactive' as const
      }
      const sharedLinkPaths = getRepoSshConnectionId(repo) ? [] : getWorktreeSharedLinkPaths(repo)
      const executionOptions = {
        ...(Object.keys(localGitOptions).length > 0
          ? { localGitExecOptions: localGitOptions }
          : {}),
        ...(sharedLinkPaths.length > 0 ? { sharedLinkPaths } : {})
      }
      const input = {
        provider: args.provider,
        base: args.base,
        head: args.head,
        title: args.title,
        body: args.body,
        draft: args.draft,
        ...(args.useTemplate !== undefined ? { useTemplate: args.useTemplate } : {})
      }
      const result = await createStackedHostedReview(
        worktreePath,
        input,
        getStoredRepoExecutionHostId(repo),
        executionOptions
      )
      if (result.ok && !stats.hasCountedPR(result.url)) {
        stats.record({
          type: 'pr_created',
          at: Date.now(),
          repoId: repo.id,
          meta: { prNumber: result.number, prUrl: result.url }
        })
      }
      return result
    }
  )
}
