import { ipcMain } from 'electron'
import { resolve } from 'node:path'
import type {
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEnqueueResult,
  GitHubPRRefreshReason,
  PRRefreshOutcome
} from '../../shared/github/pull-request-refresh-types'
import type { Repo } from '../../shared/repo-types'
import { getPRForBranch, type GitHubPRBranchLookupOptions } from '../github/client'
import {
  clearVisiblePRRefreshWindow,
  enqueuePRRefresh,
  refreshPRNow,
  reportVisiblePRRefreshCandidates,
  setPRRefreshOutcomeObserver
} from '../github/pr-refresh-coordinator'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import {
  applyRegisteredRepoToPRRefreshCandidate,
  assertRegisteredGitHubRepo,
  getGitHubLocalGitOptionArgs,
  getGitHubRepoConnectionId,
  validateAutomaticPRRefreshCandidate
} from './github-repo-routing'

const visibilityCleanupRegistered = new Set<number>()

export function registerGitHubPRRefreshHandlers(store: Store, stats: StatsCollector): void {
  function recordPRIfNeeded(repo: Repo, outcome: PRRefreshOutcome): void {
    if (outcome.kind === 'found' && !stats.hasCountedPR(outcome.pr.url)) {
      stats.record({
        type: 'pr_created',
        at: Date.now(),
        repoId: repo.id,
        meta: { prNumber: outcome.pr.number, prUrl: outcome.pr.url }
      })
    }
  }

  setPRRefreshOutcomeObserver((candidate, outcome) => {
    const repo =
      store.getRepos().find((entry) => entry.id === candidate.repoId) ??
      store.getRepos().find((entry) => resolve(entry.path) === resolve(candidate.repoPath))
    if (repo) {
      recordPRIfNeeded(repo, outcome)
    }
  })

  ipcMain.handle(
    'gh:prForBranch',
    async (
      _event,
      args: {
        repoPath: string
        branch: string
        linkedPRNumber?: number | null
        fallbackPRNumber?: number | null
        acceptMergedFallbackPR?: boolean
        currentHeadOid?: string | null
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      const localGitOptions = getGitHubLocalGitOptionArgs(store, repo)[0]
      const hostedReviewOptions = localGitOptions
        ? { localGitExecOptions: localGitOptions }
        : undefined
      const currentHeadOid =
        typeof args.currentHeadOid === 'string' && args.currentHeadOid.trim().length > 0
          ? args.currentHeadOid.trim()
          : null
      const lookupOptions: GitHubPRBranchLookupOptions | undefined = hostedReviewOptions
        ? { ...hostedReviewOptions }
        : args.acceptMergedFallbackPR === true || currentHeadOid !== null
          ? {}
          : undefined
      if (lookupOptions && args.acceptMergedFallbackPR === true) {
        lookupOptions.acceptMergedFallbackPR = true
      }
      if (lookupOptions && currentHeadOid !== null) {
        lookupOptions.currentHeadOid = currentHeadOid
      }
      const lookupOptionArgs: [] | [GitHubPRBranchLookupOptions] = lookupOptions
        ? [lookupOptions]
        : []
      const pr = await getPRForBranch(
        repo.path,
        args.branch,
        args.linkedPRNumber ?? null,
        getGitHubRepoConnectionId(repo),
        args.linkedPRNumber == null ? (args.fallbackPRNumber ?? null) : null,
        ...lookupOptionArgs
      )
      if (pr && !stats.hasCountedPR(pr.url)) {
        stats.record({
          type: 'pr_created',
          at: Date.now(),
          repoId: repo.id,
          meta: { prNumber: pr.number, prUrl: pr.url }
        })
      }
      return pr
    }
  )

  ipcMain.handle(
    'gh:refreshPRNow',
    async (
      _event,
      args: { candidate: GitHubPRRefreshCandidate; reason?: GitHubPRRefreshReason }
    ) => {
      const repo = assertRegisteredGitHubRepo(args.candidate, store)
      const outcome = await refreshPRNow(
        applyRegisteredRepoToPRRefreshCandidate(store, repo, args.candidate),
        args.reason
      )
      recordPRIfNeeded(repo, outcome)
      return outcome
    }
  )

  ipcMain.handle(
    'gh:enqueuePRRefresh',
    (
      event,
      args: {
        candidate: GitHubPRRefreshCandidate
        reason: GitHubPRRefreshReason
        priority?: number
      }
    ): GitHubPRRefreshEnqueueResult => {
      const validation = validateAutomaticPRRefreshCandidate(args.candidate, store)
      if (validation.kind === 'skipped') {
        return validation.result
      }
      enqueuePRRefresh(validation.candidate, args.reason, args.priority ?? 0, event?.sender?.id)
      return { kind: 'queued' }
    }
  )

  ipcMain.handle(
    'gh:reportVisiblePRRefreshCandidates',
    (event, args: { candidates: GitHubPRRefreshCandidate[]; generation: number }) => {
      const senderId = event.sender.id
      if (!visibilityCleanupRegistered.has(senderId)) {
        visibilityCleanupRegistered.add(senderId)
        event.sender.once('destroyed', () => {
          visibilityCleanupRegistered.delete(senderId)
          clearVisiblePRRefreshWindow(senderId)
        })
      }
      const candidates: GitHubPRRefreshCandidate[] = []
      const repos = store.getRepos()
      for (const candidate of args.candidates) {
        const validation = validateAutomaticPRRefreshCandidate(candidate, store, repos)
        if (validation.kind === 'ok') {
          candidates.push(validation.candidate)
        }
      }
      reportVisiblePRRefreshCandidates(candidates, args.generation, senderId)
      return true
    }
  )
}
