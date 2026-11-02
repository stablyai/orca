import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ConnectionState } from '../../transport/types'
import type { RpcClient } from '../../transport/rpc-client'
import {
  isPrSidebarDetailsPlaceholder,
  type PrSidebarData,
  type PrSidebarState
} from '../../session/mobile-pr-sidebar-state'
import type { GitHubWorkItemDetails } from '../../../../src/shared/github/work-item-types'
import type { PrSidebarLoadOptions } from '../../session/use-mobile-pr-sidebar-controller'
import type { PrSidebarLoadResult } from '../../session/pr-sidebar-load-result'
import type { MobileGitStatusResult } from '../../source-control/mobile-git-status'
import { useMobilePrActions, type MobilePrActions } from '../../session/use-mobile-pr-actions'
import { useMobilePrCommentActions } from '../../session/use-mobile-pr-comment-actions'
import { useMobilePrTextAction } from '../../session/use-mobile-pr-text-action'
import { useMobilePrAiTriage, type MobilePrAiTriage } from '../../session/use-mobile-pr-ai-triage'
import { usePRBotAuthorOverrides } from '../../session/use-pr-bot-author-overrides'
import { useHostProtocolGates } from '../host-protocol-gates-context'
import { useMobilePrPolling, type PrTabLive } from './use-mobile-pr-polling'
import { unlinkMobilePr } from '../../source-control/mobile-pr-link'
import { translate } from '../../i18n/mobile-i18n'
import type { PRCheckDetail } from '../../../../src/shared/github/check-types'
import { fetchPRCheckDetails } from '../../session/github-pr-rpc'
import type { DetailEntry } from './PRCheckDetail'
import { prCheckKey } from './pr-checks-presentation'

const NO_DETAILS: Record<string, DetailEntry> = {}

export type PrTabScreen = 'checks' | 'comments'
export type PrTabSheet = 'merge' | 'reviewers' | 'createPr' | 'editTitle' | 'editDescription'
export type PrTabConfirm = 'close' | 'reopen' | 'unlink'

type Input = {
  state: PrSidebarState
  refetch: (options?: PrSidebarLoadOptions) => Promise<PrSidebarLoadResult> | void
  /** What is on screen, so the PR keeps itself fresh only while someone is looking. */
  live?: PrTabLive
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  gitBranch: string | null
  gitStatus: MobileGitStatusResult | null
  headSha: string | null
  /** Named when an AI button's agent starts; the branch stands in when absent. */
  workspaceLabel: string | null
  /** The hub bar's PR actions and agent launcher, so the bar and this tab share one in-flight state. */
  shared?: { actions: MobilePrActions; triage: MobilePrAiTriage }
  /** Pushes Checks or Comments; the hub's pager owns the motion. */
  onOpenScreen: (screen: PrTabScreen) => void
  /** Bounds the branch's own commits when the host cannot report a merge base. */
  commitsAhead?: number | null
  /** A Create PR that has to commit first uses the Changes composer's message. */
  readCommitMessage?: () => string
  /** Runs before Create starts, e.g. to cancel a composer message still generating. */
  beforeCreate?: () => void
  /** Every finished Create, failed ones too, since the run may have committed before failing. */
  onCreateSettled?: (settled: MobilePrCreateSettled) => void
}

export type MobilePrCreateSettled = { created: MobilePrCreated | null; committed: boolean }

export type MobilePrCreated = {
  url: string
  warning: string | null
  provider: string
  committed: boolean
}

// One owner for the PR tab's mutations, sheets and openers, so the hub bar and the tab body drive the same state.
export function useMobilePrTab(input: Input) {
  const { state, refetch, client, connState, worktreeId, gitBranch, onOpenScreen } = input
  const launchWorkspaceLabel = input.workspaceLabel || gitBranch
  const prNumber = state.kind === 'ready' ? state.data.pr.number : 0
  // Keep stable PRInfo.prRepo identity; cloning owner/repo thrashes mutation/comment/title hooks.
  const prRepo = state.kind === 'ready' ? (state.data.pr.prRepo ?? null) : null
  // Mutations refetch and wait; they do not care whether the read landed.
  const refetchAfterMutation = useCallback(async (): Promise<void> => {
    await refetch()
  }, [refetch])
  const ownActions = useMobilePrActions({
    client,
    connState,
    worktreeId,
    prNumber,
    headSha: input.headSha,
    prRepo,
    refetch: refetchAfterMutation
  })
  const commentActions = useMobilePrCommentActions({
    client,
    connState,
    worktreeId,
    prNumber,
    prRepo,
    refetch: refetchAfterMutation
  })
  const textAction = useMobilePrTextAction({
    client,
    connState,
    worktreeId,
    prNumber,
    prRepo,
    refetch: refetchAfterMutation
  })
  const clearTextError = textAction.clearError
  const { polling } = useMobilePrPolling({
    state,
    refetch,
    live: input.live ?? false,
    connected: connState === 'connected'
  })
  const { hostCapabilities, statusPending, statusReadable } = useHostProtocolGates()
  const ownTriage = useMobilePrAiTriage({
    client,
    connState,
    worktreeId,
    workspaceLabel: launchWorkspaceLabel,
    hostCapabilities,
    hostStatusPending: statusPending,
    hostStatusReadable: statusReadable
  })
  const actions = input.shared?.actions ?? ownActions
  const triage = input.shared?.triage ?? ownTriage
  // Key overrides on PR payload so every refetch refreshes them instead of keeping a session-long snapshot.
  const botAuthorOverrides = usePRBotAuthorOverrides(
    client,
    connState,
    state.kind === 'ready' ? state.data.details : null
  )

  // Check details outlive the Checks screen, so going back and in again does not refetch them; they belong to one PR.
  const detailsOwner = `${worktreeId}\u0000${prNumber}`
  const [detailsState, setDetailsState] = useState<{
    owner: string
    entries: Record<string, DetailEntry>
  }>({ owner: detailsOwner, entries: {} })
  const checkDetails = detailsState.owner === detailsOwner ? detailsState.entries : NO_DETAILS
  // Read through a ref so the fetch starts here, not inside a state updater React may replay.
  const checkDetailsRef = useRef(checkDetails)
  useLayoutEffect(() => {
    checkDetailsRef.current = checkDetails
  })
  const ensureCheckDetail = useCallback(
    (check: PRCheckDetail) => {
      const key = prCheckKey(check)
      const existing = checkDetailsRef.current[key]
      // A failed read is retried on the next open; only loaded and in-flight reads are kept.
      if ((existing && existing.status !== 'error') || !client) {
        return
      }
      const loading: DetailEntry = { status: 'loading' }
      checkDetailsRef.current = { ...checkDetailsRef.current, [key]: loading }
      setDetailsState((prev) => ({
        owner: detailsOwner,
        entries: { ...(prev.owner === detailsOwner ? prev.entries : NO_DETAILS), [key]: loading }
      }))
      void fetchPRCheckDetails(client, worktreeId, {
        checkRunId: check.checkRunId,
        workflowRunId: check.workflowRunId,
        checkName: check.name,
        url: check.url,
        prRepo
      })
        .then((outcome): DetailEntry =>
          outcome.ok
            ? { status: 'loaded', details: outcome.result }
            : { status: 'error', message: outcome.error }
        )
        .catch((err: unknown): DetailEntry => ({ status: 'error', message: String(err) }))
        .then((entry) =>
          setDetailsState((current) =>
            current.owner === detailsOwner
              ? { owner: detailsOwner, entries: { ...current.entries, [key]: entry } }
              : current
          )
        )
    },
    [client, detailsOwner, prRepo, worktreeId]
  )

  // A sheet belongs to the PR (or, for Create, the branch) it opened for; a switch closes it rather than retargeting a save.
  const sheetOwner = (kind: PrTabSheet) =>
    kind === 'createPr'
      ? `${worktreeId}\u0000${gitBranch}`
      : `${worktreeId}\u0000${gitBranch}\u0000${prNumber}`
  const [opened, setOpened] = useState<{ kind: PrTabSheet; owner: string } | null>(null)
  const sheet = opened && opened.owner === sheetOwner(opened.kind) ? opened.kind : null
  const sheetOwnerRef = useRef(sheetOwner)
  useLayoutEffect(() => {
    sheetOwnerRef.current = sheetOwner
  })
  const setSheet = useCallback((kind: PrTabSheet | null) => {
    setOpened(kind ? { kind, owner: sheetOwnerRef.current(kind) } : null)
  }, [])
  const sheetRef = useRef(sheet)
  useLayoutEffect(() => {
    sheetRef.current = sheet
  })
  const afterSheetCloseRef = useRef<(() => void) | null>(null)
  // A running Create holds its sheet up (the drawer refuses dismissal), so the run's result has somewhere to land.
  const [creatingPr, setCreatingPr] = useState(false)
  const [confirm, setConfirm] = useState<PrTabConfirm | null>(null)
  const [unlinking, setUnlinking] = useState(false)
  // An unlink failure belongs to the PR it was for, and the next menu action replaces it.
  const [unlinkFailure, setUnlinkFailure] = useState<{ owner: string; message: string } | null>(
    null
  )
  const unlinkError = unlinkFailure?.owner === detailsOwner ? unlinkFailure.message : null
  const openConfirm = useCallback((next: PrTabConfirm | null) => {
    setUnlinkFailure(null)
    setConfirm(next)
  }, [])

  const unlink = useCallback(async (): Promise<void> => {
    if (!client || unlinking || prNumber === 0) {
      return
    }
    setUnlinking(true)
    setUnlinkFailure(null)
    try {
      const outcome = await unlinkMobilePr(client, worktreeId, prNumber)
      if (outcome.ok) {
        refetch()
      } else {
        setUnlinkFailure({ owner: detailsOwner, message: outcome.error })
      }
    } catch (err) {
      setUnlinkFailure({
        owner: detailsOwner,
        message:
          err instanceof Error
            ? err.message
            : translate(
                'pullRequest.prActionsSection.unlinkFailed',
                'Failed to unlink pull request.'
              )
      })
    } finally {
      setUnlinking(false)
    }
  }, [client, detailsOwner, prNumber, refetch, unlinking, worktreeId])

  return {
    ...input,
    workspaceLabel: launchWorkspaceLabel,
    actions,
    commentActions,
    textAction,
    triage,
    botAuthorOverrides,
    sheet,
    closeSheet: useCallback(() => setSheet(null), [setSheet]),
    // A save or merge that lands late closes only its own sheet, never one opened since.
    closeSheetIf: useCallback(
      (kind: PrTabSheet) => {
        if (sheetRef.current === kind) {
          setSheet(null)
        }
      },
      [setSheet]
    ),
    closeSheetThen: useCallback(
      (next: () => void) => {
        if (sheetRef.current === null) {
          next()
          return
        }
        afterSheetCloseRef.current = next
        setSheet(null)
      },
      [setSheet]
    ),
    polling,
    creatingPr,
    setCreatingPr,
    checkDetails,
    ensureCheckDetail,
    onSheetAfterClose: useCallback(() => {
      // A sheet closed by a PR switch must not come back if the user switches back.
      setOpened((current) =>
        current && current.owner === sheetOwnerRef.current(current.kind) ? current : null
      )
      const next = afterSheetCloseRef.current
      afterSheetCloseRef.current = null
      next?.()
    }, []),
    openMergeSheet: useCallback(() => setSheet('merge'), [setSheet]),
    openReviewersSheet: useCallback(() => setSheet('reviewers'), [setSheet]),
    openCreatePrSheet: useCallback(() => setSheet('createPr'), [setSheet]),
    openEditTitleSheet: useCallback(() => {
      clearTextError()
      setSheet('editTitle')
    }, [clearTextError, setSheet]),
    openEditDescriptionSheet: useCallback(() => {
      clearTextError()
      setSheet('editDescription')
    }, [clearTextError, setSheet]),
    openChecksScreen: useCallback(() => onOpenScreen('checks'), [onOpenScreen]),
    openCommentsScreen: useCallback(() => onOpenScreen('comments'), [onOpenScreen]),
    confirm,
    setConfirm: openConfirm,
    unlink,
    unlinking,
    unlinkError
  }
}

export type MobilePrTab = ReturnType<typeof useMobilePrTab>

export function readyPrData(tab: Pick<MobilePrTab, 'state'>): PrSidebarData | null {
  return tab.state.kind === 'ready' ? tab.state.data : null
}

/** Details that loaded; null while loading and for the failure placeholder. */
export function livePrDetails(details: GitHubWorkItemDetails | null): GitHubWorkItemDetails | null {
  return details && !isPrSidebarDetailsPlaceholder(details) ? details : null
}
