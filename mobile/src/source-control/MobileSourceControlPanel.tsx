import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'
import { GitBranch, RefreshCw } from 'lucide-react-native'
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
  buildMobileSourceControlPrimaryAction,
  resolveMobileSourceControlReviewInputs
} from './mobile-source-control-primary-action'
import { MobileSourceControlModals } from './MobileSourceControlModals'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { MobileSourceControlHubCommitsPage } from './MobileSourceControlHubCommitsPage'
import { MobileSourceControlNextStepBar } from './MobileSourceControlNextStepBar'
import { useMobileSourceControlNextStep } from './use-mobile-source-control-next-step'
import { OptionPager } from '../components/BottomDrawer'
import { useSourceControlHubNavigation } from './use-source-control-hub-navigation'
import { styles } from './mobile-source-control-styles'
import { hubStyles } from './mobile-source-control-hub-styles'
import {
  SOURCE_CONTROL_HUB_TABS,
  SOURCE_CONTROL_HUB_TAB_LABELS,
  type SourceControlHubRouteTab
} from './mobile-source-control-hub-tab'
import { groupMobileSourceControlMenu } from './mobile-source-control-actions'
import { useMobilePrSidebarController } from '../session/use-mobile-pr-sidebar-controller'
import { prSidebarDetailsNeedFetch } from '../session/mobile-pr-sidebar-state'
import { MobilePrTabBody } from '../components/MobilePRSidebar'
import { MobilePrTabSheets } from '../components/pr-sidebar/MobilePrTabSheets'
import { PrTabScreenView } from '../components/pr-sidebar/PrTabScreenView'
import {
  useMobileSourceControlPrTab,
  type MobilePrTabOpeners
} from './use-mobile-source-control-pr-tab'
import { openMobilePrUrl } from '../components/mobile-pr-url'

export type MobileSourceControlPanelProps = {
  hostId: string
  worktreeId: string
  name?: string
  embedded?: boolean
  initialTab?: SourceControlHubRouteTab
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
  const {
    screens: hubScreens,
    activeTab,
    visitedTabs,
    selectTab
  } = useSourceControlHubNavigation(initialTab)
  const [barHeight, setBarHeight] = useState(0)
  const openHubScreen = hubScreens.open
  const openCommitsScreen = useCallback(() => openHubScreen('commits'), [openHubScreen])
  // The PR tab owns the Create PR and Merge sheets; the bar and Changes reach them through this.
  const prOpeners = useRef<MobilePrTabOpeners>({ createPr: () => {}, merge: () => {} })
  const openCreatePr = useCallback(() => prOpeners.current.createPr(), [])
  const openMergeSheet = useCallback(() => prOpeners.current.merge(), [])

  const state = useMobileSourceControlState({
    hostId,
    worktreeId,
    name,
    onOpenHistory: openCommitsScreen,
    onCreatePr: openCreatePr
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
    branchCompareResult
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
  // The menu closes on a pick; the bar and the rows show the action's progress.
  const gitMenu = useMemo(
    () =>
      groupMobileSourceControlMenu(
        actionSheetActions.map((action) => ({
          ...action,
          id: action.id ?? '',
          skipAutoClose: false
        }))
      ),
    [actionSheetActions]
  )
  const primaryAction = useMemo(
    () => buildMobileSourceControlPrimaryAction({ ...primaryActionArgs, review }),
    [primaryActionArgs, review, t]
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

  // A push leaves HEAD where it was, so reread the PR once it lands: its checks moved to the pushed head.
  const aheadOfUpstream = status?.upstreamStatus?.ahead ?? 0
  const lastAheadRef = useRef(aheadOfUpstream)
  useEffect(() => {
    const pushed = lastAheadRef.current > 0 && aheadOfUpstream === 0
    lastAheadRef.current = aheadOfUpstream
    if (pushed && isHostedRepo && prBranch && prSidebarKind === 'ready') {
      void refetchPrRef.current({ includeDetails: activeTab === 'pr' })
    }
  }, [aheadOfUpstream, activeTab, isHostedRepo, prBranch, prSidebarKind])

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

  const nextStep = useMobileSourceControlNextStep({
    worktreeId,
    state,
    primaryAction,
    review,
    prState: prController.prSidebarState,
    reviewsSupported: isHostedRepo && prBranch !== null,
    refetchPr,
    headSha: prHeadSha,
    showWorkflowErrors: activeTab !== 'changes',
    onMerge: openMergeSheet
  })

  const barInset =
    nextStep.view.kind === 'hidden' && !nextStep.notice
      ? insets.bottom
      : Math.max(barHeight, insets.bottom)

  const onRefresh = useCallback(() => {
    void loadStatus({ preserveReadyOnFailure: true, rereadSettings: true })
    if (!isHostedRepo) {
      return
    }
    if (activeTab === 'pr') {
      void refetchPr({ includeDetails: true })
      return
    }
    void refetchPr({ includeDetails: false })
  }, [activeTab, isHostedRepo, loadStatus, refetchPr])
  // Changes: the rarer git actions, then Refresh, then Force push last and red.
  const changesMenuGroups = useMemo(
    () => [
      ...gitMenu.groups,
      [
        {
          id: 'refresh',
          label: t('sourceControl.header.refresh', 'Refresh source control'),
          icon: RefreshCw,
          disabled: ioBusy,
          onPress: onRefresh
        }
      ],
      ...(gitMenu.forcePush ? [[{ ...gitMenu.forcePush, destructive: true }]] : [])
    ],
    [gitMenu, ioBusy, onRefresh, t]
  )
  const { prTab, prMenuGroups, branchCompare } = useMobileSourceControlPrTab({
    state,
    activeTab,
    hubPage: hubScreens.page,
    worktreeId,
    prController,
    prBranch,
    prHeadSha,
    ready,
    selectTab,
    onRefresh,
    openersRef: prOpeners,
    openScreen: openHubScreen,
    shared: nextStep
  })

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
      menuGroups={
        activeTab === 'pr'
          ? prMenuGroups
          : activeTab === 'changes' && ready
            ? changesMenuGroups
            : null
      }
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

  const showChanges = ready && (activeTab === 'changes' || visitedTabs.has('changes'))
  // Unmount inactive PR content to release Mermaid WebViews and avoid comment rerenders per keystroke.
  const showPrBody = ready && activeTab === 'pr'

  const hub = (
    <View style={styles.container}>
      {embedded ? (
        <View style={styles.header}>{header}</View>
      ) : (
        <SafeAreaView style={styles.header} edges={['top']}>
          {header}
        </SafeAreaView>
      )}

      {showChanges ? (
        <View style={activeTab === 'changes' ? hubStyles.tabBody : hubStyles.tabBodyHidden}>
          <MobileSourceControlContent
            state={state}
            bottomInset={barInset}
            onOpenCommits={openCommitsScreen}
          />
        </View>
      ) : activeTab === 'changes' ? (
        statusGate
      ) : null}

      {showPrBody ? (
        <View style={hubStyles.tabBody}>
          <MobilePrTabBody
            tab={prTab}
            onRetry={prController.retryPRSidebar}
            bottomInset={barInset}
            onOpenChanges={() => selectTab('changes')}
            branchCompare={branchCompare}
          />
        </View>
      ) : activeTab === 'pr' ? (
        statusGate
      ) : null}

      {ready ? (
        <MobileSourceControlNextStepBar
          view={nextStep.view}
          notice={nextStep.notice ?? prTab.unlinkError}
          agentNotice={nextStep.agentNotice}
          mergeConfirm={nextStep.mergeConfirm}
          composer={state}
          primaryAction={primaryAction}
          keyboardLift={state.keyboardLift}
          bottomInset={insets.bottom}
          onHeightChange={setBarHeight}
        />
      ) : null}
    </View>
  )

  return (
    <View ref={setRootRef} style={styles.container}>
      <OptionPager
        fill
        pager={hubScreens}
        main={hub}
        page={
          hubScreens.page === 'commits' ? (
            <MobileSourceControlHubCommitsPage
              state={state}
              hostId={hostId}
              worktreeId={worktreeId}
              embedded={embedded}
              review={review}
              statusHead={statusHead}
              onBack={hubScreens.close}
            />
          ) : hubScreens.page ? (
            <PrTabScreenView
              screen={hubScreens.page}
              tab={prTab}
              onBack={hubScreens.close}
              bottomInset={insets.bottom}
              onOpenFile={(filePath) =>
                state.openDiffForFile({ kind: 'changes', filePath, area: 'branch' })
              }
            />
          ) : null
        }
      />
      <MobileSourceControlModals state={state} />
      <MobilePrTabSheets tab={prTab} />
    </View>
  )
}
