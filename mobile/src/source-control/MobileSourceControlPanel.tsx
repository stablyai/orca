import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors } from '../theme/mobile-theme'
import { useMobileSourceControlState } from './use-mobile-source-control-state'
import { useMobileSourceControlActionSheet } from './use-mobile-source-control-action-sheet'
import { MobileSourceControlHeader } from './MobileSourceControlHeader'
import { MobileSourceControlContent } from './MobileSourceControlContent'
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
import { openMobilePrUrl } from '../components/MobilePrComposeSheet'

export type MobileSourceControlPanelProps = {
  hostId: string
  worktreeId: string
  name?: string
  /** Where the panel was launched from; drives the file-open dismissal path. */
  origin?: string
  embedded?: boolean
  /** Initial hub segment (from the route's `tab` deep-link param). */
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
  // Track first visit so Changes/History stay mounted (keep scroll) after first open; PR still unmounts when inactive.
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<SourceControlHubTab>>(
    () => new Set<SourceControlHubTab>([initialTab])
  )
  const [historyRefreshNonce, setHistoryRefreshNonce] = useState(0)

  // expo-router reuses the screen instance when only query params change, so adopt the new tab.
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

  // Keep last-known branch/head across a transient status unload so the PR controller isn't wiped ready → hidden → cold start.
  const lastPrBranchRef = useRef<string | null>(null)
  const lastPrHeadRef = useRef<string | null>(null)
  useEffect(() => {
    lastPrBranchRef.current = null
    lastPrHeadRef.current = null
  }, [worktreeId])
  const statusBranch = status?.branch ?? null
  const statusHead = status?.head ?? branchCompareResult?.summary.headOid ?? null
  // Write last-known identity in an effect, not render: a discarded concurrent render must not leave the fallback stale.
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
  const isHostedRepo = prController.prSidebarIsGithubRepo
  const prSidebarKind = prController.prSidebarState.kind
  const refetchPr = prController.refetchPRSidebar
  const ensurePrDetails = prController.ensurePrSidebarDetails
  // Refs so tab effects do not re-fire when headSha recreates load() (soft refresh).
  const refetchPrRef = useRef(refetchPr)
  refetchPrRef.current = refetchPr
  const ensurePrDetailsRef = useRef(ensurePrDetails)
  ensurePrDetailsRef.current = ensurePrDetails

  // Chip bootstrap: phase-1 only (PR + checks); full payload waits for the PR segment so opening SC to stage doesn't pull details.
  useEffect(() => {
    if (activeTab === 'pr') {
      return
    }
    if (prBranch && isHostedRepo && prSidebarKind === 'hidden') {
      void refetchPrRef.current({ includeDetails: false })
    }
  }, [activeTab, prBranch, isHostedRepo, prSidebarKind])

  // Keyed by PR number, not a boolean, so a same-branch PR swap re-arms phase 2 for the new PR.
  const prDetailsMissingFor =
    prController.prSidebarState.kind === 'ready' &&
    prSidebarDetailsNeedFetch(prController.prSidebarState.data.details)
      ? prController.prSidebarState.data.pr.number
      : null

  // PR segment full load / phase-2 fill-in; key on prBranch so a branch arriving while open still loads (kind stays 'hidden').
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
    // No branch (detached HEAD / mid-rebase) never loads a PR, so state stays 'hidden'; hide the chip or it spins forever.
    if (!isHostedRepo || !prBranch) {
      return null
    }
    const commentCount =
      prController.prSidebarState.kind === 'ready'
        ? countUnresolvedReviewThreads(prController.prSidebarState.data.details?.comments)
        : null
    return buildMobilePrChipSummary(prController.prSidebarState, commentCount)
  }, [isHostedRepo, prBranch, prController.prSidebarState])

  // Refresh the active segment plus git.status (branch card stays honest on History); preserve ready on failure so the PR chip isn't wiped.
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
    // Changes: light chip refresh so the branch card stays current without comments.
    void refetchPr({ includeDetails: false })
  }, [activeTab, isHostedRepo, loadStatus, refetchPr])

  // Embedded mode docks beside the terminal: close the dock instead of popping a route; skip safe-area chrome (the dock column owns it).
  const onBack = embedded ? (onRequestClose ?? (() => router.back())) : () => router.back()
  // Chromeless PR body has no header, so surface open-on-web on the hub chrome while the PR segment is active.
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
      onRefresh={onRefresh}
      onOpenPrWeb={prWebUrl ? () => openMobilePrUrl(prWebUrl) : undefined}
      prNumber={prWebNumber}
    />
  )

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
        {screenState.kind === 'error' ? (
          <Pressable
            style={styles.retryButton}
            onPress={() => {
              // Why: a parked reconnect loop makes retry useless — revive the connection instead (issue #5049); loadStatus re-runs on reconnect.
              if (connState !== 'connected' && hostId) {
                void forceReconnect(hostId)
                return
              }
              void loadStatus()
            }}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    ) : null

  // History only needs the RPC client, so it isn't gated on git.status; Changes/PR need status (branch, files, head).
  const showChanges = ready && (activeTab === 'changes' || visitedTabs.has('changes'))
  const showHistory = activeTab === 'history' || visitedTabs.has('history')
  // Only mount PR body while active: keep-mounting retained Mermaid WebViews and re-rendered the comment tree per keystroke.
  const showPrBody = ready && activeTab === 'pr'
  const conflictOperation = status?.conflictOperation ?? null
  // Git status always reports a conflictOperation enum; 'unknown' means none.
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

      {/* On the PR tab the branch card duplicates the ready PR body, so hide it there — unless a conflict is active, which only this card can abort. */}
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
          <MobileSourceControlContent state={state} />
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
            // Gate on the probe too: isGithubRepo=false mid-probe must render loading, not flash "unavailable".
            branchContextLoaded={ready && prController.prSidebarRepoProbeLoaded}
            controller={prController}
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
