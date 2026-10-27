import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors } from '../theme/mobile-theme'
import { connectionRetryAction } from '../transport/connection-retry-action'
import { useMobileSourceControlState } from './use-mobile-source-control-state'
import { useMobileSourceControlActionSheet } from './use-mobile-source-control-action-sheet'
import { MobileSourceControlHeader } from './MobileSourceControlHeader'
import { MobileSourceControlContent } from './MobileSourceControlContent'
import {
  buildMobileSourceControlPrimaryAction,
  resolveMobileSourceControlReviewInputs
} from './mobile-source-control-primary-action'
import { MobileSourceControlModals } from './MobileSourceControlModals'
import { MobileSourceControlSegments } from './MobileSourceControlSegments'
import { MobileSourceControlBranchCard } from './MobileSourceControlBranchCard'
import { MobileGitHistoryList } from './MobileGitHistoryList'
import { styles } from './mobile-source-control-styles'
import { hubStyles } from './mobile-source-control-hub-styles'
import type { SourceControlHubTab } from './mobile-source-control-hub-tab'
import { buildMobilePrChipSummary, countUnresolvedReviewThreads } from './mobile-pr-chip-summary'
import { isMobileConflictAborting } from './mobile-source-control-conflict-abort'
import { useMobilePrSidebarController } from '../session/use-mobile-pr-sidebar-controller'
import { prSidebarDetailsNeedFetch } from '../session/mobile-pr-sidebar-state'
import { MobilePrViewPanelBody } from '../components/pr-sidebar/MobilePrViewPanel'
import { openMobilePrUrl } from '../components/mobile-pr-url'

export type MobileSourceControlPanelProps = {
  hostId: string
  worktreeId: string
  name?: string
  origin?: string
  embedded?: boolean
  initialTab?: SourceControlHubTab
  onRequestClose?: () => void
  onFileOpenStart?: () => void
  onOpenedFileDiff?: (relativePath: string) => void
}

export function MobileSourceControlPanel({
  hostId,
  worktreeId,
  name = '',
  origin = '',
  embedded = false,
  initialTab = 'changes',
  onRequestClose,
  onFileOpenStart,
  onOpenedFileDiff
}: MobileSourceControlPanelProps) {
  const [activeTab, setActiveTab] = useState<SourceControlHubTab>(initialTab)
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<SourceControlHubTab>>(
    () => new Set<SourceControlHubTab>([initialTab])
  )
  const [historyRefreshNonce, setHistoryRefreshNonce] = useState(0)

  // Query-only navigation reuses this screen; adopt the new tab.
  useEffect(() => {
    setActiveTab(initialTab)
    setVisitedTabs((prev) => {
      if (prev.has(initialTab)) {
        return prev
      }
      const next = new Set(prev)
      next.add(initialTab)
      return next
    })
  }, [initialTab])

  const selectTab = useCallback((tab: SourceControlHubTab) => {
    setActiveTab(tab)
    setVisitedTabs((prev) => {
      if (prev.has(tab)) {
        return prev
      }
      const next = new Set(prev)
      next.add(tab)
      return next
    })
  }, [])
  const openHistoryTab = useCallback(() => selectTab('history'), [selectTab])
  const openPrTab = useCallback(() => selectTab('pr'), [selectTab])

  const state = useMobileSourceControlState({
    hostId,
    worktreeId,
    name,
    origin,
    embedded,
    onRequestClose,
    onFileOpenStart,
    onOpenedFileDiff,
    onOpenHistory: openHistoryTab
  })
  const actionSheetActions = useMobileSourceControlActionSheet(state)
  const {
    client,
    connState,
    forceReconnect,
    insets,
    router,
    setRootRef,
    worktreeLabel,
    screenState,
    busyAction,
    openingPath,
    openingBranchPath,
    loadStatus,
    status,
    branchCompareResult,
    branchLabel,
    syncLabel,
    unstagedCount,
    stagedCount,
    branchEntries,
    abortConflictOperation
  } = state
  const ioBusy = busyAction !== null || openingPath !== null || openingBranchPath !== null
  const ready = screenState.kind === 'ready'

  // Retain branch/head through status unloads so the PR controller does not reset to a cold start.
  const lastPrBranchRef = useRef<string | null>(null)
  const lastPrHeadRef = useRef<string | null>(null)
  useEffect(() => {
    lastPrBranchRef.current = null
    lastPrHeadRef.current = null
  }, [worktreeId])
  const statusBranch = status?.branch ?? null
  const statusHead = status?.head ?? branchCompareResult?.summary.headOid ?? null
  // Update fallback identity after commit; discarded concurrent renders must not change it.
  useEffect(() => {
    if (statusBranch) {
      lastPrBranchRef.current = statusBranch
    }
    if (statusHead) {
      lastPrHeadRef.current = statusHead
    }
  }, [statusBranch, statusHead])
  const prBranch = statusBranch ?? lastPrBranchRef.current
  const prHeadSha = statusHead ?? lastPrHeadRef.current
  const prController = useMobilePrSidebarController({
    client,
    connState,
    worktreeId,
    branch: prBranch,
    headSha: prHeadSha
  })
  const prSidebarState = prController.prSidebarState
  const review = useMemo(
    () => resolveMobileSourceControlReviewInputs(prSidebarState),
    [prSidebarState]
  )
  const primaryActionArgs = state.primaryActionArgs
  const primaryAction = useMemo(
    () => buildMobileSourceControlPrimaryAction({ ...primaryActionArgs, review }),
    [primaryActionArgs, review]
  )
  const isHostedRepo = prController.prSidebarIsGithubRepo
  const prSidebarKind = prController.prSidebarState.kind
  const refetchPr = prController.refetchPRSidebar
  const ensurePrDetails = prController.ensurePrSidebarDetails
  // Keep tab effects stable when soft-refresh load changes with headSha.
  const refetchPrRef = useRef(refetchPr)
  refetchPrRef.current = refetchPr
  const ensurePrDetailsRef = useRef(ensurePrDetails)
  ensurePrDetailsRef.current = ensurePrDetails

  useEffect(() => {
    if (activeTab === 'pr') {
      return
    }
    if (prBranch && isHostedRepo && prSidebarKind === 'hidden') {
      void refetchPrRef.current({ includeDetails: false })
    }
  }, [activeTab, prBranch, isHostedRepo, prSidebarKind])

  const prDetailsMissingFor =
    prController.prSidebarState.kind === 'ready' &&
    prSidebarDetailsNeedFetch(prController.prSidebarState.data.details)
      ? prController.prSidebarState.data.pr.number
      : null

  useEffect(() => {
    if (activeTab !== 'pr' || !isHostedRepo || !prBranch) {
      return
    }
    if (prSidebarKind === 'hidden') {
      void refetchPrRef.current({ includeDetails: true })
      return
    }
    if (prDetailsMissingFor != null) {
      void ensurePrDetailsRef.current()
    }
  }, [activeTab, isHostedRepo, prBranch, prSidebarKind, prDetailsMissingFor])

  const prChip = useMemo(() => {
    // Detached HEAD never loads PR state; hide the chip instead of leaving it spinning.
    if (!isHostedRepo || !prBranch) {
      return null
    }
    const commentCount =
      prController.prSidebarState.kind === 'ready'
        ? countUnresolvedReviewThreads(prController.prSidebarState.data.details?.comments)
        : null
    return buildMobilePrChipSummary(prController.prSidebarState, commentCount)
  }, [isHostedRepo, prBranch, prController.prSidebarState])

  const onRefresh = useCallback(() => {
    void loadStatus({ preserveReadyOnFailure: true })
    if (activeTab === 'history') {
      setHistoryRefreshNonce((n) => n + 1)
      return
    }
    if (!isHostedRepo) {
      return
    }
    if (activeTab === 'pr') {
      void refetchPr({ includeDetails: true })
      return
    }
    void refetchPr({ includeDetails: false })
  }, [activeTab, isHostedRepo, loadStatus, refetchPr])

  // Embedded close dismisses the dock; route Back pops. The dock column owns safe-area chrome.
  const onBack = () => router.back()
  const onClose = onRequestClose ?? (() => router.back())
  const prWebUrl =
    activeTab === 'pr' &&
    prController.prSidebarState.kind === 'ready' &&
    prController.prSidebarState.data.pr.url
      ? prController.prSidebarState.data.pr.url
      : null
  const prWebNumber =
    prController.prSidebarState.kind === 'ready' ? prController.prSidebarState.data.pr.number : null
  const header = (
    <MobileSourceControlHeader
      embedded={embedded}
      worktreeLabel={worktreeLabel}
      ioBusy={ioBusy}
      onBack={onBack}
      onClose={onClose}
      onRefresh={onRefresh}
      onOpenPrWeb={prWebUrl ? () => openMobilePrUrl(prWebUrl) : undefined}
      prNumber={prWebNumber}
    />
  )

  // Revive parked reconnect loops; loadStatus reruns after connection.
  const statusRetry = connectionRetryAction({
    hostId,
    needsReconnect: connState !== 'connected',
    forceReconnect,
    reload: () => void loadStatus()
  })
  const statusGate =
    screenState.kind === 'loading' ? (
      <View style={styles.state}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
      </View>
    ) : screenState.kind === 'error' || screenState.kind === 'unavailable' ? (
      <View style={styles.state}>
        <Text style={styles.stateTitle}>
          {screenState.kind === 'unavailable' ? 'Source Control Unavailable' : 'Unable to Load'}
        </Text>
        <Text style={styles.stateText}>{screenState.message}</Text>
        {screenState.kind === 'error' && statusRetry ? (
          <Pressable style={styles.retryButton} onPress={statusRetry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    ) : null

  // History needs only RPC; Changes and PR also need branch/file status.
  const showChanges = ready && (activeTab === 'changes' || visitedTabs.has('changes'))
  const showHistory = activeTab === 'history' || visitedTabs.has('history')
  // Unmount inactive PR content to release Mermaid WebViews and avoid comment rerenders per keystroke.
  const showPrBody = ready && activeTab === 'pr'
  const conflictOperation = status?.conflictOperation ?? null
  const hasActiveConflict = conflictOperation != null && conflictOperation !== 'unknown'
  const conflictAborting = isMobileConflictAborting(busyAction, conflictOperation)

  return (
    <View ref={setRootRef} style={styles.container}>
      {embedded ? (
        <View style={styles.header}>{header}</View>
      ) : (
        <SafeAreaView style={styles.header} edges={['top']}>
          {header}
        </SafeAreaView>
      )}

      <MobileSourceControlSegments active={activeTab} onSelect={selectTab} />

      {/* Ready PRs duplicate the branch card; retain it only when needed to abort a conflict. */}
      {ready && (activeTab !== 'pr' || hasActiveConflict) ? (
        <MobileSourceControlBranchCard
          branchLabel={branchLabel}
          syncLabel={syncLabel}
          unstagedCount={unstagedCount}
          stagedCount={stagedCount}
          branchCount={branchEntries.length}
          conflictOperation={conflictOperation}
          conflictBusy={busyAction !== null}
          conflictAborting={conflictAborting}
          onAbortConflict={(operation) => void abortConflictOperation(operation)}
          prChip={prChip}
          onOpenPr={openPrTab}
        />
      ) : null}

      {showChanges ? (
        <View style={activeTab === 'changes' ? hubStyles.tabBody : hubStyles.tabBodyHidden}>
          <MobileSourceControlContent state={state} primaryAction={primaryAction} />
        </View>
      ) : activeTab === 'changes' ? (
        statusGate
      ) : null}

      {showPrBody ? (
        <View style={hubStyles.tabBody}>
          <MobilePrViewPanelBody
            client={client}
            connState={connState}
            worktreeId={worktreeId}
            branch={prBranch}
            headSha={prHeadSha}
            gitStatus={status}
            isGithubRepo={isHostedRepo}
            // Mid-probe false is still loading; do not flash unavailable.
            branchContextLoaded={ready && prController.prSidebarRepoProbeLoaded}
            controller={prController}
            workspaceLabel={worktreeLabel}
          />
        </View>
      ) : activeTab === 'pr' ? (
        statusGate
      ) : null}

      {showHistory ? (
        <View style={activeTab === 'history' ? hubStyles.tabBody : hubStyles.tabBodyHidden}>
          <MobileGitHistoryList
            client={client}
            connState={connState}
            worktreeId={worktreeId}
            hostId={hostId}
            bottomInset={insets.bottom}
            refreshNonce={historyRefreshNonce}
          />
        </View>
      ) : null}

      <MobileSourceControlModals state={state} actionSheetActions={actionSheetActions} />
    </View>
  )
}
