import { useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, Platform } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useHostClient, useForceReconnect } from '../transport/client-context'
import { getWorktreeLabel } from '../session/worktree-label'
import type { MobilePrPrefill } from './mobile-pr-create'
import { useMobileGitRequests } from './use-mobile-git-requests'
import { useMobileSourceControlLoaders } from './use-mobile-source-control-loaders'
import { useMobileSourceControlOpeners } from './use-mobile-source-control-openers'
import { useMobileSourceControlRunners } from './use-mobile-source-control-runners'
import type { RuntimeGitLocalBranches } from '../../../src/shared/runtime-types'
import {
  buildMobileBranchCompareSection,
  canOpenMobileBranchCompareDiff,
  formatMobileBranchCompareSummary
} from './mobile-branch-compare'
import {
  buildMobileSourceControlSections,
  countStagedEntries,
  countUnstagedEntries,
  getStageablePaths,
  getUnstageablePaths,
  isMobileGitDiscardableEntry,
  isMobileGitStageableEntry,
  type MobileGitStatusEntry
} from './mobile-git-status'
import {
  formatBranchLabel,
  type MobileBranchEntryView,
  type MobileGitStatusEntryView
} from './mobile-source-control-screen-state'

type MobileGitLocalBranches = RuntimeGitLocalBranches

export type MobileSourceControlStateParams = {
  hostId: string
  worktreeId: string
  name: string
  origin: string
  embedded: boolean
  onRequestClose?: () => void
}

export function useMobileSourceControlState(params: MobileSourceControlStateParams) {
  const { hostId, worktreeId, name, origin, embedded, onRequestClose } = params
  const insets = useSafeAreaInsets()
  const { client, state: connState } = useHostClient(hostId)
  const forceReconnect = useForceReconnect()
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [generatingMessage, setGeneratingMessage] = useState(false)
  const [showPrSheet, setShowPrSheet] = useState(false)
  const [showBranchPicker, setShowBranchPicker] = useState(false)
  const [localBranches, setLocalBranches] = useState<MobileGitLocalBranches | null>(null)
  const [createdPrUrl, setCreatedPrUrl] = useState<string | null>(null)
  const [createdPrWarning, setCreatedPrWarning] = useState<string | null>(null)
  const [prPrefill, setPrPrefill] = useState<MobilePrPrefill | null>(null)
  const [discardTarget, setDiscardTarget] = useState<MobileGitStatusEntry | null>(null)
  const [showActionSheet, setShowActionSheet] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [keyboardLift, setKeyboardLift] = useState(0)
  const busyActionRef = useRef<string | null>(null)
  const worktreeLabel = getWorktreeLabel(name, worktreeId)
  const statusIdentityKey = `${hostId}\0${worktreeId}`

  const { screenState, branchCompareState, mountedRef, setRootRef, loadStatus } =
    useMobileSourceControlLoaders({
      client,
      connState,
      statusIdentityKey,
      worktreeId,
      setActionError
    })

  const {
    router,
    branchDiffPreview,
    setBranchDiffPreview,
    openingPath,
    openingBranchPath,
    openFile,
    openBranchDiff
  } = useMobileSourceControlOpeners({
    client,
    connState,
    hostId,
    worktreeId,
    name,
    origin,
    embedded,
    onRequestClose,
    branchCompareState,
    mountedRef,
    busyActionRef,
    setActionError
  })

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'

    const onShow = Keyboard.addListener(showEvent, (event) => {
      const height = event.endCoordinates.height - (Platform.OS === 'ios' ? insets.bottom : 0)
      setKeyboardLift(Math.max(0, height))
    })
    const onHide = Keyboard.addListener(hideEvent, () => setKeyboardLift(0))

    return () => {
      onShow.remove()
      onHide.remove()
    }
  }, [insets.bottom])

  const status = screenState.kind === 'ready' ? screenState.status : null
  const entries = status?.entries ?? []
  const derivedEntries = useMemo<MobileGitStatusEntryView[]>(
    () =>
      entries.map((entry) => ({
        ...entry,
        canDiscard: isMobileGitDiscardableEntry(entry),
        canOpen: entry.status !== 'deleted' && entry.conflictStatus !== 'unresolved',
        canStage: isMobileGitStageableEntry(entry),
        discardActionId: `discard:${entry.path}`,
        stageActionId: `stage:${entry.path}`,
        unstageActionId: `unstage:${entry.path}`
      })),
    [entries]
  )
  const sections = useMemo(() => buildMobileSourceControlSections(derivedEntries), [derivedEntries])
  const branchCompareResult = branchCompareState.kind === 'ready' ? branchCompareState.result : null
  const branchCompareSection = useMemo(
    () => buildMobileBranchCompareSection(branchCompareResult?.entries ?? []),
    [branchCompareResult]
  )
  const branchCompareSummaryText = branchCompareResult
    ? formatMobileBranchCompareSummary(branchCompareResult.summary)
    : null
  const branchCompareCanOpen = branchCompareResult
    ? canOpenMobileBranchCompareDiff(branchCompareResult.summary)
    : false
  const branchEntries = useMemo<MobileBranchEntryView[]>(
    () =>
      (branchCompareSection?.data ?? []).map((entry) => ({
        ...entry,
        canOpen: branchCompareCanOpen
      })),
    [branchCompareCanOpen, branchCompareSection]
  )
  const shouldShowBranchCompareSection =
    branchEntries.length > 0 ||
    branchCompareState.kind === 'loading' ||
    branchCompareState.kind === 'error' ||
    (branchCompareResult !== null && branchCompareResult.summary.status !== 'ready')
  const hasVisibleChanges = sections.length > 0 || shouldShowBranchCompareSection
  const reviewableCount = entries.length + (branchCompareCanOpen ? branchEntries.length : 0)
  const stageablePaths = useMemo(() => getStageablePaths(entries), [entries])
  const unstageablePaths = useMemo(() => getUnstageablePaths(entries), [entries])
  const stagedCount = useMemo(() => countStagedEntries(entries), [entries])
  const unstagedCount = useMemo(() => countUnstagedEntries(entries), [entries])
  const branchLabel = formatBranchLabel(status?.branch, status?.head)
  const upstream = status?.upstreamStatus
  const upstreamKnown = upstream !== undefined
  const syncLabel =
    upstream && upstream.hasUpstream
      ? `${upstream.ahead} ahead, ${upstream.behind} behind`
      : upstream && !upstream.hasUpstream
        ? 'No upstream'
        : null

  const { sendGitRequest, sendCommitRequest, runGitSyncSteps } = useMobileGitRequests({
    client,
    connState,
    worktreeId
  })

  const runners = useMobileSourceControlRunners({
    client,
    hostId,
    worktreeId,
    status,
    branchLabel,
    commitMessage,
    generatingMessage,
    stageablePaths,
    unstageablePaths,
    router,
    sendGitRequest,
    sendCommitRequest,
    runGitSyncSteps,
    loadStatus,
    mountedRef,
    busyActionRef,
    setBusyAction,
    setActionError,
    setCommitMessage,
    setGeneratingMessage,
    setShowActionSheet,
    setLocalBranches,
    setShowBranchPicker,
    setPrPrefill,
    setShowPrSheet
  })

  return {
    client,
    connState,
    forceReconnect,
    insets,
    router,
    setRootRef,
    worktreeLabel,
    // screen state
    screenState,
    branchCompareState,
    branchDiffPreview,
    setBranchDiffPreview,
    busyAction,
    commitMessage,
    setCommitMessage,
    generatingMessage,
    showPrSheet,
    setShowPrSheet,
    showBranchPicker,
    setShowBranchPicker,
    localBranches,
    createdPrUrl,
    setCreatedPrUrl,
    createdPrWarning,
    setCreatedPrWarning,
    prPrefill,
    discardTarget,
    setDiscardTarget,
    showActionSheet,
    setShowActionSheet,
    actionError,
    keyboardLift,
    openingPath,
    openingBranchPath,
    // derived
    status,
    sections,
    branchCompareResult,
    branchCompareSummaryText,
    branchEntries,
    shouldShowBranchCompareSection,
    hasVisibleChanges,
    reviewableCount,
    stageablePaths,
    unstageablePaths,
    stagedCount,
    unstagedCount,
    branchLabel,
    upstream,
    upstreamKnown,
    syncLabel,
    // actions
    loadStatus,
    openFile,
    openBranchDiff,
    ...runners
  }
}

export type MobileSourceControlState = ReturnType<typeof useMobileSourceControlState>
