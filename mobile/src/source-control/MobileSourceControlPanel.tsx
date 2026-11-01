import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'
import { GitBranch } from 'lucide-react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  MobileLoadErrorState,
  MobileOfflineState,
  MobileStateView
} from '../components/MobileStateView'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { connectionRetryAction } from '../transport/connection-retry-action'
import { useMobileSourceControlState } from './use-mobile-source-control-state'
import { useMobileSourceControlActionSheet } from './use-mobile-source-control-action-sheet'
import { MobileSourceControlHeader } from './MobileSourceControlHeader'
import { MobileSourceControlContent } from './MobileSourceControlContent'
import {
  buildMobileBranchRemoteAction,
  buildMobileSourceControlPrimaryAction,
  resolveMobileSourceControlReviewInputs
} from './mobile-source-control-primary-action'
import { MobileSourceControlModals } from './MobileSourceControlModals'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { MobileSourceControlBranchCard } from './MobileSourceControlBranchCard'
import { MobileCommitPageHost, MobileCommitsScreen } from './MobileCommitsScreen'
import { styles } from './mobile-source-control-styles'
import { hubStyles } from './mobile-source-control-hub-styles'
import {
  SOURCE_CONTROL_HUB_TABS,
  SOURCE_CONTROL_HUB_TAB_LABELS,
  type SourceControlHubTab
} from './mobile-source-control-hub-tab'
import { buildMobilePrChipSummary, countUnresolvedReviewThreads } from './mobile-pr-chip-summary'
import { MOBILE_COMPLETE_MERGE_ACTION_ID } from './mobile-source-control-conflict-actions'
import { isMobileConflictAborting } from './mobile-source-control-conflict-abort'
import { useMobilePrSidebarController } from '../session/use-mobile-pr-sidebar-controller'
import { prSidebarDetailsNeedFetch } from '../session/mobile-pr-sidebar-state'
import { MobilePrViewPanelBody } from '../components/pr-sidebar/MobilePrViewPanel'
import { openMobilePrUrl } from '../components/mobile-pr-url'

export type MobileSourceControlPanelProps = {
  hostId: string
  worktreeId: string
  name?: string
  embedded?: boolean
  initialTab?: SourceControlHubTab
  onRequestClose?: () => void
}

export function MobileSourceControlPanel({
  hostId,
  worktreeId,
  name = '',
  embedded = false,
  initialTab = 'changes',
  onRequestClose
}: MobileSourceControlPanelProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
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
    onOpenHistory: openHistoryTab
  })
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
    loadStatus,
    status,
    branchCompareResult,
    branchLabel,
    syncLabel,
    unstagedCount,
    stagedCount,
    branchEntries,
    abortConflictOperation,
    completeMerge,
    actionError,
    runActionSheetRebase
  } = state
  const ioBusy = busyAction !== null
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
  const actionSheetActions = useMobileSourceControlActionSheet(state, review)
  const primaryAction = useMemo(
    () => buildMobileSourceControlPrimaryAction({ ...primaryActionArgs, review }),
    [primaryActionArgs, review, t]
  )
  const branchRemoteAction = useMemo(
    () => buildMobileBranchRemoteAction({ ...primaryActionArgs, review }),
    [primaryActionArgs, review, t]
  )
  // Pass primitives and a stable runner so commit-message keystrokes do not rerender the Commits list.
  const branchRemoteActionRef = useRef(branchRemoteAction)
  useEffect(() => {
    branchRemoteActionRef.current = branchRemoteAction
  }, [branchRemoteAction])
  const runBranchRemoteAction = useCallback(
    () => branchRemoteActionRef.current?.run() ?? Promise.resolve(),
    []
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
  }, [isHostedRepo, prBranch, prController.prSidebarState, t])

  const onRefresh = useCallback(() => {
    void loadStatus({ preserveReadyOnFailure: true, rereadSettings: true })
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
      accessory={
        <MobileSegmentedControl
          segments={SOURCE_CONTROL_HUB_TABS.map((tab) => ({
            value: tab,
            label: SOURCE_CONTROL_HUB_TAB_LABELS[tab]
          }))}
          selected={activeTab}
          onSelect={selectTab}
          fill
          tabs
          style={hubStyles.segments}
        />
      }
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
      <MobileStateView loading title={t('sourceControl.panel.loading', 'Loading changes…')} />
    ) : screenState.kind === 'unavailable' ? (
      <MobileStateView
        icon={GitBranch}
        title={t('sourceControl.panel.unavailableTitle', 'Source Control Unavailable')}
        message={screenState.message}
      />
    ) : screenState.kind === 'error' && connState !== 'connected' ? (
      <MobileOfflineState onReconnect={statusRetry} />
    ) : screenState.kind === 'error' ? (
      <MobileLoadErrorState error={screenState.message} onRetry={statusRetry} />
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
      {/* A commit covers the whole screen, header and segments too, with only its own header. */}
      <MobileCommitPageHost
        key={`${hostId}\0${worktreeId}`}
        client={client}
        connState={connState}
        worktreeId={worktreeId}
        bottomInset={insets.bottom}
        padTop={!embedded}
      >
        {(openCommit) => (
          <View style={styles.container}>
            {embedded ? (
              <View style={styles.header}>{header}</View>
            ) : (
              <SafeAreaView style={styles.header} edges={['top']}>
                {header}
              </SafeAreaView>
            )}

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
                // Failures render in the Changes body, so offer completion only where they can be read.
                onCompleteMerge={
                  activeTab === 'changes' &&
                  conflictOperation === 'merge' &&
                  !primaryActionArgs.hasUnresolvedConflicts
                    ? () => void completeMerge()
                    : null
                }
                completingMerge={busyAction === MOBILE_COMPLETE_MERGE_ACTION_ID}
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
                <MobileCommitsScreen
                  client={client}
                  connState={connState}
                  worktreeId={worktreeId}
                  hostId={hostId}
                  bottomInset={insets.bottom}
                  refreshNonce={historyRefreshNonce}
                  refreshKey={`${statusHead ?? ''}:${status?.upstreamStatus?.ahead ?? ''}:${status?.upstreamStatus?.behind ?? ''}`}
                  branchName={branchLabel}
                  busyAction={busyAction}
                  actionError={actionError}
                  pushLabel={branchRemoteAction?.label}
                  pushDisabled={branchRemoteAction?.disabled}
                  pushBusy={branchRemoteAction?.loading}
                  onPush={runBranchRemoteAction}
                  onUpdateBranch={runActionSheetRebase}
                  onOpenCommit={openCommit}
                />
              </View>
            ) : null}
          </View>
        )}
      </MobileCommitPageHost>

      <MobileSourceControlModals state={state} actionSheetActions={actionSheetActions} />
    </View>
  )
}
