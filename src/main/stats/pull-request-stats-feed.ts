import { resolve } from 'node:path'
import type { Repo } from '../../shared/repository/repo-types'
import { addPRRefreshOutcomeObserver } from '../github/pull-requests/refresh/pr-refresh-coordinator'
import type { StatsCollector } from './collector'

export function feedPullRequestStats(
  stats: StatsCollector,
  readRepos: () => readonly Pick<Repo, 'id' | 'path'>[]
): () => void {
  return addPRRefreshOutcomeObserver((candidate, outcome) => {
    if (outcome.kind !== 'found' || stats.hasCountedPR(outcome.pr.url)) {
      return
    }
    const repos = readRepos()
    const repo =
      repos.find((entry) => entry.id === candidate.repoId) ??
      repos.find((entry) => resolve(entry.path) === resolve(candidate.repoPath))
    if (repo) {
      stats.record({
        type: 'pr_created',
        at: Date.now(),
        repoId: repo.id,
        meta: { prNumber: outcome.pr.number, prUrl: outcome.pr.url }
      })
    }
  })
}
