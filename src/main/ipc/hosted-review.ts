import { ipcMain } from 'electron'
import { resolve } from 'path'
import type { HostedReviewForBranchArgs } from '../../shared/hosted-review'
import type { Repo } from '../../shared/types'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import { getHostedReviewForBranch } from '../source-control/hosted-review'

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

export function registerHostedReviewHandlers(store: Store, stats: StatsCollector): void {
  ipcMain.handle('hostedReview:forBranch', async (_event, args: HostedReviewForBranchArgs) => {
    const repo = assertRegisteredRepo(args.repoPath, store, args.repoId)
    const review = await getHostedReviewForBranch({
      repoPath: repo.path,
      connectionId: repo.connectionId,
      branch: args.branch,
      linkedGitHubPR: args.linkedGitHubPR ?? null,
      linkedGitLabMR: args.linkedGitLabMR ?? null,
      linkedBitbucketPR: args.linkedBitbucketPR ?? null,
      linkedGiteaPR: args.linkedGiteaPR ?? null
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
}
