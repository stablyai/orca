import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from 'react'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { PrSidebarState } from '../session/mobile-pr-sidebar-state'
import type { MobilePrSidebarController } from '../session/use-mobile-pr-sidebar-controller'
import {
  useMobilePrTab,
  type MobilePrCreateSettled,
  type PrTabScreen
} from '../components/pr-sidebar/use-mobile-pr-tab'
import { usePrTabMenuGroups } from '../components/pr-sidebar/use-pr-tab-menu'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import type { SourceControlHubTab } from './mobile-source-control-hub-tab'
import type { SourceControlHubScreen } from './use-source-control-hub-navigation'
import type { MobilePrActions } from '../session/use-mobile-pr-actions'
import type { MobilePrAiTriage } from '../session/use-mobile-pr-ai-triage'

/** The hub's way into the PR tab's sheets, filled once the tab exists. */
export type MobilePrTabOpeners = { createPr: () => void; merge: () => void }

type Args = {
  state: MobileSourceControlState
  activeTab: SourceControlHubTab
  /** The screen pushed over the hub, so Checks and Comments stay live while open. */
  hubPage: SourceControlHubScreen | null
  worktreeId: string
  prController: MobilePrSidebarController
  prBranch: string | null
  prHeadSha: string | null
  ready: boolean
  selectTab: (tab: SourceControlHubTab) => void
  onRefresh: () => void
  /** The bar and Changes-tab Create PR entries reach the PR tab's sheets through this. */
  openersRef: MutableRefObject<MobilePrTabOpeners>
  /** Pushes Checks or Comments on the hub's pager. */
  openScreen: (screen: PrTabScreen) => void
  /** The next-step bar's actions engine and launcher, shared so the bar and the tab agree. */
  shared: { actions: MobilePrActions; triage: MobilePrAiTriage }
}

// The hub's wiring of the PR tab: its state, Create PR follow-through, sheet openers and ⋯ menu.
export function useMobileSourceControlPrTab({
  state,
  activeTab,
  hubPage,
  worktreeId,
  prController,
  prBranch,
  prHeadSha,
  ready,
  selectTab,
  onRefresh,
  openersRef,
  openScreen,
  shared
}: Args) {
  const t = useMobileTranslation()
  const { client, connState, status, worktreeLabel, loadStatus, branchCompareResult } = state
  const isHostedRepo = prController.prSidebarIsGithubRepo
  const refetchPr = prController.refetchPRSidebar
  // Mid-probe false is still loading; do not flash unavailable.
  const prTabState: PrSidebarState = !(ready && prController.prSidebarRepoProbeLoaded)
    ? { kind: 'loading' }
    : !isHostedRepo
      ? {
          kind: 'blocked',
          message: t(
            'pullRequest.prViewPanel.providerUnavailable',
            'Hosted review panel unavailable for this provider.'
          )
        }
      : prBranch === null
        ? {
            kind: 'error',
            message: t('pullRequest.prViewPanel.branchUnavailable', 'Current branch unavailable.')
          }
        : prController.prSidebarState
  const commitMessageRef = useRef(state.commitMessage)
  useLayoutEffect(() => {
    commitMessageRef.current = state.commitMessage
  })
  const { setCommitMessage, setCreatedPrUrl, setCreatedPrWarning, cancelGenerateCommitMessage } =
    state
  const onCreateSettled = useCallback(
    ({ created, committed }: MobilePrCreateSettled) => {
      // The run may commit before push or create fails; the composer and Changes must catch up either way.
      if (committed) {
        setCommitMessage('')
      }
      void loadStatus({ preserveReadyOnFailure: true, force: true })
      if (!created) {
        return
      }
      // Only GitHub has a PR tab; other providers keep today's Created notice with its Open link.
      if (created.provider === 'github' && isHostedRepo) {
        void refetchPr({ includeDetails: true })
        selectTab('pr')
        // "Created, but not refreshed" or "already open" still needs saying, with its link.
        if (!created.warning) {
          return
        }
      }
      setCreatedPrUrl(created.url)
      setCreatedPrWarning(created.warning)
    },
    [
      isHostedRepo,
      loadStatus,
      refetchPr,
      selectTab,
      setCommitMessage,
      setCreatedPrUrl,
      setCreatedPrWarning
    ]
  )
  const prTab = useMobilePrTab({
    // Comments keep their threads fresh; the tab and Checks need only the PR and its checks.
    live:
      hubPage === 'comments'
        ? 'details'
        : hubPage === 'checks' || activeTab === 'pr'
          ? 'checks'
          : false,
    state: prTabState,
    refetch: refetchPr,
    client,
    connState,
    worktreeId,
    gitBranch: prBranch,
    gitStatus: status,
    headSha: prHeadSha,
    workspaceLabel: worktreeLabel,
    shared,
    onOpenScreen: openScreen,
    commitsAhead: branchCompareResult?.summary.commitsAhead ?? null,
    readCommitMessage: () => commitMessageRef.current,
    beforeCreate: cancelGenerateCommitMessage,
    onCreateSettled
  })
  useLayoutEffect(() => {
    openersRef.current = { createPr: prTab.openCreatePrSheet, merge: prTab.openMergeSheet }
  })
  const prMenuGroups = usePrTabMenuGroups(prTab, onRefresh)

  const summary = branchCompareResult?.summary
  const branchCompare =
    summary?.status === 'ready'
      ? { commitsAhead: summary.commitsAhead, baseRef: summary.baseRef }
      : null
  return { prTab, prMenuGroups, branchCompare }
}
