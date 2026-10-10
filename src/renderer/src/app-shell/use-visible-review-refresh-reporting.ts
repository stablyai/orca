import { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '../store'
import type { AppState } from '../store/types'
import { rightSidebarShowsPullRequestData } from '../lib/right-sidebar-visibility'
import { findWorktreeById, buildPRRefreshCandidate } from '../store/github/worktree-refresh'
import { getHostedReviewCacheKey } from '../store/slices/hosted-review-cache-identity'
import { getIndexedRepoMap } from '../store/worktree-repo-index'
import { shouldCoordinateVisibleGitHubReview } from '../store/github/visible-hosted-review-refresh-ownership'
import { getPRRefreshRuntimeRepoTarget } from '../store/github/repository-routing'
import {
  reviewRefreshIntervalMs,
  REVIEW_REFRESH_COOLDOWN_MS
} from '../../../shared/review-refresh-policy'

export function visibleReviewWorktreeIdsForState(state: AppState): string[] {
  const ids = new Set(state.visibleReviewCardWorktreeIds ?? [])
  const repos = getIndexedRepoMap(state.repos)
  if (state.activeWorktreeId && rightSidebarShowsPullRequestData(state)) {
    ids.add(state.activeWorktreeId)
  }
  return Array.from(ids).filter((id) => {
    const worktree = findWorktreeById(state, id)
    const repo = worktree && repos.get(worktree.repoId)
    return (
      worktree &&
      repo &&
      (repo.kind ?? 'git') === 'git' &&
      !worktree.isBare &&
      !worktree.isArchived &&
      Boolean(worktree.branch)
    )
  })
}

function reportIdentity(state: AppState): string {
  return JSON.stringify([
    state.activeWorktreeId,
    rightSidebarShowsPullRequestData(state),
    state.sshConnectedGeneration,
    state.prVisibleRefreshGeneration,
    visibleReviewWorktreeIdsForState(state).map((id) => {
      const worktree = findWorktreeById(state, id)
      if (!worktree) {
        return id
      }
      const candidate = buildPRRefreshCandidate(state, worktree)
      const key =
        candidate &&
        getHostedReviewCacheKey(
          candidate.repoPath,
          candidate.branch,
          state.settings,
          candidate.repoId,
          candidate.connectionId,
          candidate.executionHostId,
          true
        )
      return [
        id,
        worktree.branch,
        worktree.head,
        worktree.linkedPR,
        worktree.linkedGitLabMR,
        worktree.linkedBitbucketPR,
        worktree.linkedAzureDevOpsPR,
        worktree.linkedGiteaPR,
        candidate?.connectionState,
        candidate?.executionHostId,
        candidate?.cacheKey,
        getIndexedRepoMap(state.repos).get(worktree.repoId)?.gitRemoteIdentity?.canonicalKey,
        Boolean(candidate && state.prCache[candidate.cacheKey]?.data),
        key ? state.hostedReviewCache[key]?.data?.provider : null
      ]
    })
  ])
}

const REPORT_INPUT_KEYS = [
  'activeView',
  'activeWorktreeId',
  'rightSidebarOpen',
  'rightSidebarTab',
  'visibleReviewCardWorktreeIds',
  'repos',
  'worktreesByRepo',
  'settings',
  'sshConnectionStates',
  'sshConnectedGeneration',
  'prVisibleRefreshGeneration',
  'prCache',
  'hostedReviewCache'
] as const

type ReviewReportInputs = Pick<AppState, (typeof REPORT_INPUT_KEYS)[number]>

export function createVisibleReviewReportIdentitySelector(): (state: AppState) => string {
  let previous: ReviewReportInputs | null = null
  let identity = ''
  return (state) => {
    const cachedInputs = previous
    if (cachedInputs && REPORT_INPUT_KEYS.every((key) => cachedInputs[key] === state[key])) {
      return identity
    }
    // Keep only review inputs so terminal output and agent snapshots can be released.
    previous = {
      activeView: state.activeView,
      activeWorktreeId: state.activeWorktreeId,
      rightSidebarOpen: state.rightSidebarOpen,
      rightSidebarTab: state.rightSidebarTab,
      visibleReviewCardWorktreeIds: state.visibleReviewCardWorktreeIds,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo,
      settings: state.settings,
      sshConnectionStates: state.sshConnectionStates,
      sshConnectedGeneration: state.sshConnectedGeneration,
      prVisibleRefreshGeneration: state.prVisibleRefreshGeneration,
      prCache: state.prCache,
      hostedReviewCache: state.hostedReviewCache
    }
    identity = reportIdentity(state)
    return identity
  }
}

export function refreshForegroundVisibleReview(state: AppState): void {
  const id = state.activeWorktreeId
  if (!id || !rightSidebarShowsPullRequestData(state)) {
    return
  }
  const worktree = findWorktreeById(state, id)
  const candidate = worktree && buildPRRefreshCandidate(state, worktree)
  if (
    !worktree ||
    !candidate ||
    !shouldCoordinateVisibleGitHubReview(state, worktree, candidate) ||
    getPRRefreshRuntimeRepoTarget(state, candidate)
  ) {
    return
  }
  const interval =
    reviewRefreshIntervalMs({
      state: candidate.cachedPRState,
      checksStatus: candidate.cachedChecksStatus,
      hasReview: candidate.cachedHasPR,
      selected: true
    }) ?? REVIEW_REFRESH_COOLDOWN_MS
  if (
    candidate.cachedFetchedAt == null ||
    Date.now() - candidate.cachedFetchedAt >= interval ||
    (candidate.currentHeadOid != null &&
      candidate.cachedHeadOid != null &&
      candidate.currentHeadOid !== candidate.cachedHeadOid)
  ) {
    state.enqueueGitHubPRRefresh(id, 'visible', 80)
  }
}

export function useVisibleReviewRefreshReporting(): void {
  const selectIdentity = useMemo(() => createVisibleReviewReportIdentitySelector(), [])
  const foregroundRef = useRef<string | null>(null)
  const identity = useAppStore(selectIdentity)
  const report = useAppStore((s) => s.reportVisibleGitHubPRRefreshCandidates)
  useEffect(() => {
    let mounted = true
    const update = (): void => {
      const state = useAppStore.getState()
      const foreground =
        document.visibilityState === 'visible' && rightSidebarShowsPullRequestData(state)
          ? state.activeWorktreeId
          : null
      const newlyForeground = foreground !== null && foregroundRef.current !== foreground
      if (foreground === null) {
        foregroundRef.current = null
      }
      void report(
        document.visibilityState === 'visible'
          ? visibleReviewWorktreeIdsForState(useAppStore.getState())
          : [],
        Date.now()
      ).then(() => {
        const current = useAppStore.getState()
        if (
          mounted &&
          newlyForeground &&
          foregroundRef.current !== foreground &&
          rightSidebarShowsPullRequestData(current) &&
          document.visibilityState === 'visible' &&
          current.activeWorktreeId === foreground
        ) {
          foregroundRef.current = foreground
          refreshForegroundVisibleReview(current)
        }
      })
    }
    update()
    document.addEventListener('visibilitychange', update)
    return () => {
      mounted = false
      document.removeEventListener('visibilitychange', update)
    }
  }, [identity, report])
  useEffect(
    () => () => {
      void report([], Date.now())
    },
    [report]
  )
}
