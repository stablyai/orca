import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useHostConnectionInputs } from '../transport/connection/client-context-connection-metrics'
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
import { connectionRetryAction } from '../transport/connection/connection-retry-action'
import { useMobileSourceControlState } from './use-mobile-source-control-state'
import { useMobileSourceControlRefresh } from './panel/use-mobile-source-control-refresh'
import { useMobileSourceControlActionSheet } from './workflows/use-mobile-source-control-action-sheet'
import { MobileSourceControlHeader } from './panel/MobileSourceControlHeader'
import { MobileSourceControlContent } from './changes/MobileSourceControlContent'
import {
  buildMobileSourceControlPrimaryAction,
  resolveMobileSourceControlReviewInputs
} from './workflows/mobile-source-control-primary-action'
import { MobileSourceControlModals } from './panel/MobileSourceControlModals'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { MobileSourceControlHubCommitsPage } from './panel/MobileSourceControlHubCommitsPage'
import { MobileSourceControlNextStepBar } from './panel/MobileSourceControlNextStepBar'
import { useMobileSourceControlNextStep } from './panel/use-mobile-source-control-next-step'
import { OptionPager } from '../components/bottom-drawer/BottomDrawer'
import { useSourceControlHubNavigation } from './panel/use-source-control-hub-navigation'
import { styles } from './mobile-source-control-styles'
import { hubStyles } from './panel/mobile-source-control-hub-styles'
import {
  SOURCE_CONTROL_HUB_TABS,
  SOURCE_CONTROL_HUB_TAB_LABELS,
  type SourceControlHubRouteTab
} from './panel/mobile-source-control-hub-tab'
import { groupMobileSourceControlMenu } from './workflows/mobile-source-control-actions'
import { useMobilePrSidebarController } from './review/pull-request/use-mobile-pr-sidebar-controller'
import { MobilePrTabBody } from './review/pull-request/MobilePRSidebar'
import { MobilePrTabSheets } from './review/pull-request/MobilePrTabSheets'
import { PrTabScreenView } from './review/pull-request/PrTabScreenView'
import {
  useMobileSourceControlPrTab,
  type MobilePrTabOpeners
} from './panel/use-mobile-source-control-pr-tab'
import { openExternalLink as openMobilePrUrl } from '../platform/external-links/external-link'

export type MobileSourceControlPanelProps = {
  hostId: string
  worktreeId: string
  name?: string
  embedded?: boolean
  initialTab?: SourceControlHubRouteTab
  /** Back for a hub shown over another screen in place; a route's Back pops it. */
  backInPlace?: { onPress: () => void; label: string }
  onRequestClose?: () => void
}

export function MobileSourceControlPanel({
  hostId,
  worktreeId,
  name = '',
  embedded = false,
  initialTab = 'changes',
  backInPlace,
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
  const prBranch = status ? statusBranch : lastPrBranchRef.current
  const prHeadSha = statusHead ?? lastPrHeadRef.current
  // The hub always shows the PR's summary; its body and comments load once the PR tab or Comments is up.
  const prController = useMobilePrSidebarController({
    hostId,
    client,
    connState,
    worktreeId,
    branch: prBranch,
    headSha: prHeadSha,
    demand: activeTab === 'pr' || hubScreens.page === 'comments' ? 'details' : 'summary'
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
  // Keep the push effect stable when the PR read changes with headSha.
  const rereadPrAfterPush = useEffectEvent((includeDetails: boolean) => {
    void prController.refetchPRSidebar({ includeDetails })
  })

  // A push leaves HEAD where it was, so reread the PR once it lands: its checks moved to the pushed head.
  const aheadOfUpstream = status?.upstreamStatus?.ahead ?? 0
  const lastAheadRef = useRef(aheadOfUpstream)
  useEffect(() => {
    const pushed = lastAheadRef.current > 0 && aheadOfUpstream === 0
    lastAheadRef.current = aheadOfUpstream
    if (pushed && isHostedRepo && prBranch && prSidebarKind === 'ready') {
      rereadPrAfterPush(activeTab === 'pr')
    }
  }, [aheadOfUpstream, activeTab, isHostedRepo, prBranch, prSidebarKind])

  const nextStep = useMobileSourceControlNextStep({
    worktreeId,
    state,
    primaryAction,
    review,
    prState: prController.prSidebarState,
    reviewsSupported: isHostedRepo && prBranch !== null,
    rereadPr: prController.rereadPRSlices,
    headSha: prHeadSha,
    showWorkflowErrors: activeTab !== 'changes',
    onMerge: openMergeSheet
  })

  const barInset =
    nextStep.view.kind === 'hidden' && !nextStep.notice
      ? insets.bottom
      : Math.max(barHeight, insets.bottom)

  const onRefresh = useMobileSourceControlRefresh({
    loadStatus,
    prController,
    includeDetails: activeTab === 'pr'
  })
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
  const hostConnection = useHostConnectionInputs(hostId)
  const { prTab, prMenuGroups, branchCompare } = useMobileSourceControlPrTab({
    state,
    activeTab,
    hubPage: hubScreens.page,
    hostId,
    worktreeId,
    prController,
    prBranch,
    prHeadSha,
    ready,
    selectTab,
    onRefresh,
    openersRef: prOpeners,
    openScreen: openHubScreen,
    hostConnection,
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
      // Only Changes reads through the query layer so far; the PR tab keeps its own loading UI.
      refreshing={activeTab === 'changes' && state.refreshing}
      onBack={onBack}
      backInPlace={backInPlace}
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
            stageAllInBar={nextStep.view.kind === 'composer' && primaryAction.kind === 'stage'}
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
