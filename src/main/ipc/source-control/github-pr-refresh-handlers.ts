import { ipcMain } from 'electron'
import { resolve } from 'node:path'
import type {
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEnqueueResult,
  GitHubPRRefreshReason,
  PRRefreshOutcome
} from '../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { Repo } from '../../../shared/repo-types'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { getPRForBranch } from '../../github/client/lookup/get-pr-for-branch'
import type { GitHubPRBranchLookupOptions } from '../../github/client/lookup/pull-request-lookup-data'
import {
  clearVisiblePRRefreshWindow,
  enqueuePRRefresh,
  refreshPRNow,
  reportVisiblePRRefreshCandidates,
  addPRRefreshOutcomeObserver,
  setPRRefreshRegistrationCheck
} from '../../github/pull-requests/refresh/pr-refresh-coordinator'
import { setPRRefreshRendererPort } from '../../github/pull-requests/refresh/pr-refresh-renderer-port'
import { pullRequestChangeObserver } from '../../github/pull-requests/refresh/pull-request-changed-events'
import { electronPRRefreshRenderer } from '../../host/electron-pr-refresh-renderer'
import type { Store } from '../../persistence/loading-store/store'
import type { StatsCollector } from '../../stats/collector'
import {
  applyRegisteredRepoToPRRefreshCandidate,
  assertRegisteredGitHubRepo,
  assertRegisteredPRRefreshCandidateRepo,
  getGitHubLocalGitOptionArgs,
  getGitHubRepoConnectionId,
  isPRRefreshCandidateRegistered,
  readGitHubRepoUnlessWslStopped,
  validateAutomaticPRRefreshCandidate
} from './github-repo-routing'
import { abortWhenRendererGone } from '../renderer-lifetime-abort'

const visibilityCleanupRegistered = new Set<number>()

export function registerGitHubPRRefreshHandlers(
  store: Store,
  stats: StatsCollector,
  runtime: Pick<OrcaRuntimeService, 'notifyPullRequestChangedForRemoteClients'>
): void {
  // The windows these handlers serve are the renderers the coordinator reports to.
  setPRRefreshRendererPort(electronPRRefreshRenderer)
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

  addPRRefreshOutcomeObserver((candidate, outcome) => {
    const repo =
      store.getRepos().find((entry) => entry.id === candidate.repoId) ??
      store.getRepos().find((entry) => resolve(entry.path) === resolve(candidate.repoPath))
    if (repo) {
      recordPRIfNeeded(repo, outcome)
    }
  })
  // Only the desktop drives the coordinator; serve and orcad have no publisher, so phones keep polling there.
  addPRRefreshOutcomeObserver(
    pullRequestChangeObserver((change) => runtime.notifyPullRequestChangedForRemoteClients(change))
  )
  setPRRefreshRegistrationCheck((candidate) =>
    isPRRefreshCandidateRegistered(candidate, store.getRepos())
  )

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
        /** A manual refresh: a user act that may start a stopped WSL distro. */
        wakeWslDistro?: boolean
        userRefresh?: boolean
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
        : args.acceptMergedFallbackPR === true ||
            currentHeadOid !== null ||
            args.userRefresh === true
          ? {}
          : undefined
      if (lookupOptions && args.userRefresh === true) {
        lookupOptions.userRefresh = true
      }
      if (lookupOptions && args.acceptMergedFallbackPR === true) {
        lookupOptions.acceptMergedFallbackPR = true
      }
      if (lookupOptions && currentHeadOid !== null) {
        lookupOptions.currentHeadOid = currentHeadOid
      }
      const lookupOptionArgs: [] | [GitHubPRBranchLookupOptions] = lookupOptions
        ? [lookupOptions]
        : []
      // The sidebar card fallback polls this; only a manual refresh may start the distro (E9).
      const pr = await readGitHubRepoUnlessWslStopped(
        store,
        repo,
        () =>
          getPRForBranch(
            repo.path,
            args.branch,
            args.linkedPRNumber ?? null,
            getGitHubRepoConnectionId(repo),
            args.linkedPRNumber == null ? (args.fallbackPRNumber ?? null) : null,
            ...lookupOptionArgs
          ),
        { wake: args.wakeWslDistro === true }
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
      args: {
        candidate: GitHubPRRefreshCandidate
        reason?: GitHubPRRefreshReason
        userRefresh?: boolean
      }
    ) => {
      const repo = assertRegisteredPRRefreshCandidateRepo(args.candidate, store)
      const outcome = await refreshPRNow(
        applyRegisteredRepoToPRRefreshCandidate(store, repo, args.candidate),
        args.reason,
        ...(args.userRefresh === true ? ([{ userRefresh: true }] as const) : [])
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
        const lifetime = abortWhenRendererGone(event.sender)
        lifetime.signal.addEventListener(
          'abort',
          () => {
            visibilityCleanupRegistered.delete(senderId)
            clearVisiblePRRefreshWindow(senderId)
          },
          { once: true }
        )
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
