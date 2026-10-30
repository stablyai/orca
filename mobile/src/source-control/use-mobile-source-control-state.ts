import { useCallback, useMemo, useRef, useState } from 'react'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useForceReconnect } from '../transport/host-client-hooks'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { getWorktreeLabel } from '../session/worktree-label'
import { useMobileGitRequests } from './use-mobile-git-requests'
import { useMobileSourceControlLoaders } from './use-mobile-source-control-loaders'
import { useMobileSourceControlOpeners } from './use-mobile-source-control-openers'
import type { MobileSourceControlPrimaryActionArgs } from './mobile-source-control-primary-action'
import { useMobileSourceControlSections } from './mobile-source-control-sections'
import { useMobileSourceControlRunners } from './use-mobile-source-control-runners'
import { useMobileSourceControlCreatePrAction } from './use-mobile-source-control-create-pr-action'
import { useMobileSourceControlKeyboardLift } from './use-mobile-source-control-keyboard-lift'
import type { RuntimeGitLocalBranches } from '../../../src/shared/runtime-types'
import {
  buildMobileBranchCompareSection,
  canOpenMobileBranchCompareDiff,
  formatMobileBranchCompareSummary
} from './mobile-branch-compare'

import {
  countStagedEntries,
  countUnstagedEntries,
  getStageablePaths,
  getUnstageablePaths,
  type MobileGitStatusEntry
} from './mobile-git-status'
import { getMobileCommitFailureStagedEntries } from './mobile-commit-failure-recovery'
import { useMobileSourceControlCommitFailure } from './use-mobile-source-control-commit-failure'
import {
  buildMobileGitStatusEntryViews,
  formatBranchLabel,
  type MobileBranchEntryView
} from './mobile-source-control-screen-state'

export type MobileSourceControlStateParams = {
  hostId: string
  worktreeId: string
  name: string
  origin: string
  embedded: boolean
  onRequestClose?: () => void
  onFileOpenStart?: () => void
  onOpenedFileDiff?: (relativePath: string) => void
  onOpenHistory?: () => void
}

export function useMobileSourceControlState(params: MobileSourceControlStateParams) {
  const t = useMobileTranslation()
  const {
    hostId,
    worktreeId,
    name,
    origin,
    embedded,
    onRequestClose,
    onFileOpenStart,
    onOpenedFileDiff,
    onOpenHistory
  } = params
  const insets = useSafeAreaInsets()
  const { client, state: connState } = useWorkspaceClient(hostId)
  const forceReconnect = useForceReconnect()
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [generatingMessage, setGeneratingMessage] = useState(false)
  const [showBranchPicker, setShowBranchPicker] = useState(false)
  const [localBranches, setLocalBranches] = useState<RuntimeGitLocalBranches | null>(null)
  const [createdPrUrl, setCreatedPrUrl] = useState<string | null>(null)
  const [createdPrWarning, setCreatedPrWarning] = useState<string | null>(null)
  const [discardTarget, setDiscardTarget] = useState<MobileGitStatusEntry | null>(null)
  const [showActionSheet, setShowActionSheet] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const keyboardLift = useMobileSourceControlKeyboardLift()
  const busyActionRef = useRef<string | null>(null)
  const worktreeLabel = getWorktreeLabel(name, worktreeId)
  const statusIdentityKey = `${hostId}\0${worktreeId}`
  const { commitFailureRecovery, commitFailureRecoveryAction, recordCommitFailure } =
    useMobileSourceControlCommitFailure({ client, connState, worktreeId, worktreeLabel })
  const clearCommitFailureRecovery = useCallback(() => {
    recordCommitFailure(null)
  }, [recordCommitFailure])

  const loaders = useMobileSourceControlLoaders({
    client,
    connState,
    statusIdentityKey,
    worktreeId,
    setActionError,
    onStatusLoadSuccess: clearCommitFailureRecovery
  })
  const { screenState, branchCompareState, mountedRef, setRootRef, loadStatus, settings } = loaders

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
    diffShowWhitespace: settings.diffShowWhitespace,
    hostId,
    worktreeId,
    name,
    origin,
    embedded,
    onRequestClose,
    onFileOpenStart,
    onOpenedFileDiff,
    branchCompareState,
    mountedRef,
    busyActionRef,
    setActionError
  })

  const status = screenState.kind === 'ready' ? screenState.status : null
  const entries = status?.entries ?? []
  const derivedEntries = useMemo(() => buildMobileGitStatusEntryViews(entries), [entries])
  const sections = useMobileSourceControlSections(derivedEntries, settings.groupOrder)
  const branchCompareResult = branchCompareState.kind === 'ready' ? branchCompareState.result : null
  const branchCompareSection = useMemo(
    () => buildMobileBranchCompareSection(branchCompareResult?.entries ?? []),
    [branchCompareResult, t]
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
  const stageablePaths = useMemo(() => getStageablePaths(entries), [entries])
  const unstageablePaths = useMemo(() => getUnstageablePaths(entries), [entries])
  const stagedCount = useMemo(() => countStagedEntries(entries), [entries])
  const stagedEntriesForRecovery = useMemo(
    () => getMobileCommitFailureStagedEntries(entries),
    [entries]
  )
  const unstagedCount = useMemo(() => countUnstagedEntries(entries), [entries])
  const hasUnresolvedConflicts = useMemo(
    () => entries.some((entry) => entry.conflictStatus === 'unresolved'),
    [entries]
  )
  const branchLabel = formatBranchLabel(status?.branch, status?.head)
  const upstream = status?.upstreamStatus
  const upstreamKnown = upstream !== undefined
  const syncLabel =
    upstream && upstream.hasUpstream
      ? t('sourceControl.state.syncStatus', '{{ahead}} ahead, {{behind}} behind', upstream)
      : upstream && !upstream.hasUpstream
        ? t('sourceControl.state.noUpstream', 'No upstream')
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
    stagedEntries: stagedEntriesForRecovery,
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
    setCreatedPrUrl,
    setCreatedPrWarning,
    recordCommitFailure,
    onOpenHistory
  })
  // The panel adds the branch's review before building the action, so only the inputs live here.
  const primaryActionArgs = useMemo(
    (): MobileSourceControlPrimaryActionArgs => ({
      status,
      hasUnresolvedConflicts,
      stageablePaths,
      stagedCount,
      unstagedCount,
      commitMessage,
      busyAction,
      openingPath,
      openingBranchPath,
      branchCompareResult,
      handlers: {
        commit: runners.commit,
        stageAll: runners.stageAll,
        runActionSheetGitSequence: runners.runActionSheetGitSequence,
        runActionSheetGitSync: runners.runActionSheetGitSync
      }
    }),
    [
      branchCompareResult,
      busyAction,
      commitMessage,
      hasUnresolvedConflicts,
      openingBranchPath,
      openingPath,
      runners.commit,
      runners.runActionSheetGitSequence,
      runners.runActionSheetGitSync,
      runners.stageAll,
      stageablePaths,
      stagedCount,
      status,
      unstagedCount
    ]
  )
  const createPrAction = useMobileSourceControlCreatePrAction({
    client,
    connState,
    hostId,
    worktreeId,
    commitArea: primaryActionArgs,
    createPr: runners.createPr
  })

  return {
    client,
    connState,
    forceReconnect,
    insets,
    router,
    setRootRef,
    worktreeLabel,
    screenState,
    branchCompareState,
    branchDiffPreview,
    setBranchDiffPreview,
    busyAction,
    commitMessage,
    setCommitMessage,
    generatingMessage,
    showBranchPicker,
    setShowBranchPicker,
    localBranches,
    createdPrUrl,
    setCreatedPrUrl,
    createdPrWarning,
    setCreatedPrWarning,
    discardTarget,
    setDiscardTarget,
    showActionSheet,
    setShowActionSheet,
    actionError,
    commitFailureRecovery,
    commitFailureRecoveryAction,
    keyboardLift,
    openingPath,
    openingBranchPath,
    status,
    sections,
    branchCompareResult,
    branchCompareSummaryText,
    branchEntries,
    shouldShowBranchCompareSection,
    hasVisibleChanges,
    stageablePaths,
    unstageablePaths,
    stagedCount,
    unstagedCount,
    branchLabel,
    upstreamKnown,
    syncLabel,
    primaryActionArgs,
    createPrAction,
    loadStatus,
    rebaseBaseRef: loaders.rebaseBaseRef,
    openFile,
    openBranchDiff,
    ...runners
  }
}

export type MobileSourceControlState = ReturnType<typeof useMobileSourceControlState>
