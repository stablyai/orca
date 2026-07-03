import { ipcMain } from 'electron'
import { posix, resolve } from 'node:path'
import type {
  CreateHostedReviewArgs,
  HostedReviewCreationEligibilityArgs,
  HostedReviewForBranchArgs
} from '../../shared/hosted-review'
import type { Repo } from '../../shared/types'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import {
  createHostedReview,
  getHostedReviewCreationEligibility
} from '../source-control/hosted-review-creation'
import { getHostedReviewForBranch } from '../source-control/hosted-review'
import { resolveRegisteredWorktreePath } from './filesystem-auth'
import { listRepoWorktrees } from '../repo-worktrees'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'

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

async function resolveHostedReviewWorktreePath(
  repo: Repo,
  store: Store,
  worktreePath?: string
): Promise<string> {
  if (!worktreePath) {
    return repo.path
  }
  if (repo.connectionId) {
    const remoteWorktreePath = normalizeRemoteHostedReviewPath(worktreePath)
    const repoWorktrees = await listRepoWorktrees(repo)
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
      ? await listRepoWorktrees(repo, localGitOptions)
      : await listRepoWorktrees(repo)
  if (!repoWorktrees.some((worktree) => resolve(worktree.path) === resolvedWorktreePath)) {
    throw new Error('Access denied: worktree does not belong to repository')
  }
  return resolvedWorktreePath
}

function normalizeRemoteHostedReviewPath(remotePath: string): string {
  if (!remotePath || remotePath.includes('\0')) {
    throw new Error('Access denied: invalid worktree path')
  }
  // Why: SSH worktree paths belong to the remote POSIX host. Local path.resolve
  // rewrites them on Windows and cannot authorize remote-only paths.
  const normalized = posix.normalize(remotePath)
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

export function registerHostedReviewHandlers(store: Store, stats: StatsCollector): void {
  ipcMain.handle('hostedReview:forBranch', async (_event, args: HostedReviewForBranchArgs) => {
    const repo = assertRegisteredRepo(args.repoPath, store, args.repoId)
    const localGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
    const review = await getHostedReviewForBranch({
      repoPath: repo.path,
      connectionId: repo.connectionId,
      branch: args.branch,
      linkedGitHubPR: args.linkedGitHubPR ?? null,
      fallbackGitHubPR: args.linkedGitHubPR == null ? (args.fallbackGitHubPR ?? null) : null,
      linkedGitLabMR: args.linkedGitLabMR ?? null,
      linkedBitbucketPR: args.linkedBitbucketPR ?? null,
      linkedAzureDevOpsPR: args.linkedAzureDevOpsPR ?? null,
      linkedGiteaPR: args.linkedGiteaPR ?? null,
      currentHeadOid: args.currentHeadOid ?? null,
      ...(Object.keys(localGitOptions).length > 0 ? { localGitExecOptions: localGitOptions } : {})
    })
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
      const worktreePath = await resolveHostedReviewWorktreePath(repo, store, args.worktreePath)
      const localGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
      return getHostedReviewCreationEligibility({
        ...args,
        repoPath: worktreePath,
        connectionId: repo.connectionId ?? null,
        ...(Object.keys(localGitOptions).length > 0 ? { localGitExecOptions: localGitOptions } : {})
      })
    }
  )

  ipcMain.handle('hostedReview:create', async (_event, args: CreateHostedReviewArgs) => {
    const repo = assertRegisteredRepo(args.repoPath, store, args.repoId)
    const worktreePath = await resolveHostedReviewWorktreePath(repo, store, args.worktreePath)
    const localGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
    const executionOptions =
      Object.keys(localGitOptions).length > 0 ? { localGitExecOptions: localGitOptions } : undefined
    const input = {
      provider: args.provider,
      base: args.base,
      head: args.head,
      title: args.title,
      body: args.body,
      draft: args.draft,
      ...(args.useTemplate !== undefined ? { useTemplate: args.useTemplate } : {})
    }
    const result = executionOptions
      ? await createHostedReview(worktreePath, input, repo.connectionId ?? null, executionOptions)
      : await createHostedReview(worktreePath, input, repo.connectionId ?? null)
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
}
