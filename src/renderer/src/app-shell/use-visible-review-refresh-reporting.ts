import { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '../store'
import type { AppState } from '../store/types'
import { rightSidebarShowsPullRequestData } from '../lib/right-sidebar-visibility'
import { findWorktreeById, buildPRRefreshCandidate } from '../store/github/worktree-refresh'
import { getHostedReviewCacheKey } from '../store/slices/hosted-review-cache-identity'
import { getVisibleHostedReviewWorkspaces } from '../store/github/visible-hosted-review-refresh-targets'
import { shouldCoordinateVisibleGitHubReview } from '../store/github/visible-hosted-review-refresh-ownership'
import { getPRRefreshRuntimeRepoTarget } from '../store/github/repository-routing'
import {
  reviewRefreshIntervalMs,
  REVIEW_REFRESH_COOLDOWN_MS
} from '../../../shared/review-refresh-policy'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

function visibleReviewWorkspacesForState(state: AppState) {
  const ids = new Set(state.visibleReviewCardWorktreeIds ?? [])
  if (state.activeWorktreeId && rightSidebarShowsPullRequestData(state)) {
    ids.add(state.activeWorktreeId)
  }
  return [...getVisibleHostedReviewWorkspaces(state, { worktreeIds: [...ids] })].filter(
    ({ worktree }) => Boolean(worktree.branch)
  )
}

export function visibleReviewWorktreeIdsForState(state: AppState): string[] {
  return [...new Set(visibleReviewWorkspacesForState(state).map(({ worktree }) => worktree.id))]
}

function reportIdentity(state: AppState): string {
  return JSON.stringify([
    state.activeWorktreeId,
    rightSidebarShowsPullRequestData(state),
    state.sshConnectedGeneration,
    state.prVisibleRefreshGeneration,
    visibleReviewWorkspacesForState(state).map(({ worktree, repo, candidate, selected }) => {
      const key = getHostedReviewCacheKey(
        candidate.repoPath,
        candidate.branch,
        state.settings,
        candidate.repoId,
        candidate.connectionId,
        candidate.executionHostId,
        true
      )
      return [
        worktree.id,
        selected,
        worktree.branch,
        worktree.head,
        worktree.linkedPR,
        worktree.linkedGitLabMR,
        worktree.linkedBitbucketPR,
        worktree.linkedAzureDevOpsPR,
        worktree.linkedGiteaPR,
        candidate.connectionState,
        candidate.executionHostId,
        candidate.cacheKey,
        repo.gitRemoteIdentity?.canonicalKey,
        Boolean(state.prCache[candidate.cacheKey]?.data),
        state.hostedReviewCache[key]?.data?.provider
      ]
    })
  ])
}

const REPORT_INPUT_KEYS = [
  'activeView',
  'activeWorktreeId',
  'activeWorkspaceExecutionHostId',
  'rightSidebarOpen',
  'rightSidebarTab',
  'visibleReviewCardWorktreeIds',
  'visibleWorkspaceHostIds',
  'workspaceHostScope',
  'repos',
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'wslHostStatuses',
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
      activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
      rightSidebarOpen: state.rightSidebarOpen,
      rightSidebarTab: state.rightSidebarTab,
      visibleReviewCardWorktreeIds: state.visibleReviewCardWorktreeIds,
      visibleWorkspaceHostIds: state.visibleWorkspaceHostIds,
      workspaceHostScope: state.workspaceHostScope,
      repos: state.repos,
      worktreesByRepo: selectWorktreesByRepo(state),
      detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
      wslHostStatuses: state.wslHostStatuses,
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
