import { useCallback, useMemo, useRef, useState } from 'react'
import { getWorktreeLabel } from '../session/worktree-label'
import { useMobileGitRequests } from './use-mobile-git-requests'
import { useMobileSourceControlLoaders } from './use-mobile-source-control-loaders'
import { useMobileSourceControlOpeners } from './use-mobile-source-control-openers'
import { buildMobileSourceControlPrimaryAction } from './mobile-source-control-primary-action'
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
  buildMobileSourceControlSections,
  countStagedEntries,
  countUnstagedEntries,
  getStageablePaths,
  getUnstageablePaths,
  type MobileGitStatusEntry
} from './mobile-git-status'
import type { HostSourceControlBinding } from './host-source-control-binding'
import { useHostSourceControlBinding } from './use-host-source-control-binding'
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
  // When the panel runs inside the hub, "History" switches the segment instead of
  // pushing the standalone route. Absent for the standalone/dock usage.
  onOpenHistory?: () => void
  binding?: HostSourceControlBinding
}

export function useMobileSourceControlState(params: MobileSourceControlStateParams) {
  const {
    hostId,
    worktreeId,
    name,
    origin,
    embedded,
    onRequestClose,
    onFileOpenStart,
    onOpenedFileDiff,
    onOpenHistory,
    binding
  } = params
  const host = useHostSourceControlBinding(hostId, binding)
  const { client, connState, forceReconnect, feedback, prShellOperations, insets } = host
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
  const { commitFailureRecovery, commitFailureRecoveryAction, recordCommitFailure } =
    useMobileSourceControlCommitFailure({ client, connState, worktreeId })
  const clearCommitFailureRecovery = useCallback(() => {
    recordCommitFailure(null)
  }, [recordCommitFailure])

  const { screenState, branchCompareState, mountedRef, setRootRef, loadStatus } =
    useMobileSourceControlLoaders({
      client,
      connState,
      statusIdentityKey: `${hostId}\0${worktreeId}`,
      worktreeId,
      setActionError,
      onStatusLoadSuccess: clearCommitFailureRecovery
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
    onFileOpenStart,
    onOpenedFileDiff,
    branchCompareState,
    mountedRef,
    busyActionRef,
    setActionError,
    feedback
  })

  const status = screenState.kind === 'ready' ? screenState.status : null
  const entries = status?.entries ?? []
  const derivedEntries = useMemo(() => buildMobileGitStatusEntryViews(entries), [entries])
  const sections = useMemo(() => buildMobileSourceControlSections(derivedEntries), [derivedEntries])
  const branchCompareResult = branchCompareState.kind === 'ready' ? branchCompareState.result : null
  const branchCompareSection = useMemo(
    () => buildMobileBranchCompareSection(branchCompareResult?.entries ?? []),
    [branchCompareResult]
  )
  const branchCompareSummaryText = branchCompareResult
    ? formatMobileBranchCompareSummary(branchCompareResult.summary)
    : null
  const branchEntries = useMemo<MobileBranchEntryView[]>(
    () =>
      (branchCompareSection?.data ?? []).map((entry) => ({
        ...entry,
        canOpen: branchCompareResult
          ? canOpenMobileBranchCompareDiff(branchCompareResult.summary)
          : false
      })),
    [branchCompareResult, branchCompareSection]
  )
  // Local changes only: dirty files + committed file diffs vs base (not PR/push).
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
    onOpenHistory,
    feedback
  })
  const createPrAction = useMobileSourceControlCreatePrAction({
    client,
    connState,
    hostId,
    worktreeId,
    status,
    hasUncommittedChanges: entries.length > 0,
    busyAction,
    createPr: runners.createPr
  })
  const primaryAction = useMemo(
    () =>
      buildMobileSourceControlPrimaryAction({
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

  return {
    client,
    connState,
    forceReconnect,
    prShellOperations,
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
    upstream,
    upstreamKnown: upstream !== undefined,
    syncLabel,
    primaryAction,
    createPrAction,
    // actions
    loadStatus,
    openFile,
    openBranchDiff,
    ...runners
  }
}

export type MobileSourceControlState = ReturnType<typeof useMobileSourceControlState>
