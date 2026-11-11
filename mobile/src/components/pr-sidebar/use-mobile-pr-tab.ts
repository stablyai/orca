import { useCallback, useRef, useState } from 'react'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { HostConnectionInputs } from '../../transport/connection/client-context-connection-metrics'
import {
  isPrSidebarDetailsPlaceholder,
  prSidebarResourceKey,
  type PrSidebarData,
  type PrSidebarState
} from '../../source-control/review/mobile-pr-sidebar-state'
import type { GitHubWorkItemDetails } from '../../../../src/shared/github/work-item-types'
import type { PrSidebarLoadOptions } from '../../source-control/review/use-mobile-pr-sidebar-controller'
import {
  prActionSlices,
  type PrQueryScope,
  type PrSlice
} from '../../source-control/review/mobile-pr-queries'
import type { PrActionBusyKey } from '../../source-control/review/pr-actions-engine'
import type { MobileGitStatusResult } from '../../source-control/mobile-git-status'
import {
  useMobilePrActions,
  type MobilePrActions
} from '../../source-control/review/use-mobile-pr-actions'
import { useMobilePrCommentActions } from '../../source-control/review/use-mobile-pr-comment-actions'
import { useMobilePrTextAction } from '../../source-control/review/use-mobile-pr-text-action'
import {
  useMobilePrAiTriage,
  type MobilePrAiTriage
} from '../../source-control/review/use-mobile-pr-ai-triage'
import { usePRBotAuthorOverrides } from '../../source-control/review/use-pr-bot-author-overrides'
import { useHostProtocolGates } from '../host-protocol-gates-context'
import { useMobilePrPolling, type PrTabLive } from './use-mobile-pr-polling'
import { unlinkMobilePr } from '../../source-control/mobile-pr-link'
import { translate } from '../../i18n/mobile-i18n'
import { usePrCheckRunDetails } from './use-pr-check-run-details'
import {
  useSelectedScope,
  usePrTabRequests,
  type PrTabConfirm,
  type PrTabScope
} from './pr-tab-requests'

export type PrTabScreen = 'checks' | 'comments'
export type { PrTabConfirm, PrTabSheet, PrTabSheetRequest } from './pr-tab-requests'

type Input = {
  hostId: string
  state: PrSidebarState
  /** The reads behind `state`, which writes patch and polling keeps fresh. */
  queries: PrQueryScope | null
  refetch: (options?: PrSidebarLoadOptions) => Promise<void>
  /** Re-reads the parts of the PR a write changed; a failed read keeps the shown PR. */
  rereadSlices: (slices: readonly PrSlice[]) => Promise<void>
  /** What is on screen, so the PR keeps itself fresh only while someone is looking. */
  live?: PrTabLive
  client: RpcClient | null
  connState: ConnectionState
  /** The screen header's own verdict inputs, so a sheet's no-data wait reads as the header does. */
  hostConnection: HostConnectionInputs
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
  const {
    hostId,
    state,
    queries,
    refetch,
    rereadSlices,
    client,
    connState,
    worktreeId,
    gitBranch,
    onOpenScreen
  } = input
  const launchWorkspaceLabel = input.workspaceLabel || gitBranch
  const prNumber = state.kind === 'ready' ? state.data.pr.number : 0
  // Keep stable PRInfo.prRepo identity; cloning owner/repo thrashes mutation/comment/title hooks.
  const prRepo = state.kind === 'ready' ? (state.data.pr.prRepo ?? null) : null
  // The complete PR resource, not its number: fork #N and upstream #N are different owners of every cache and sheet.
  const prScope = useSelectedScope({
    client,
    worktreeId,
    branch: gitBranch,
    resource: state.kind === 'ready' ? prSidebarResourceKey(state.data.pr) : null
  })
  const branchScope = useSelectedScope({ client, worktreeId, branch: gitBranch, resource: null })
  const requests = usePrTabRequests(prScope, branchScope)
  const { setSheet } = requests
  // Every attempted action re-reads what it changed; the write's own outcome stays the only feedback.
  const rereadAfterAction = useCallback(
    (action: PrActionBusyKey) => rereadSlices(prActionSlices(action)),
    [rereadSlices]
  )
  const ownActions = useMobilePrActions({
    client,
    connState,
    worktreeId,
    prNumber,
    headSha: input.headSha,
    prRepo,
    refetch: rereadAfterAction
  })
  const commentActions = useMobilePrCommentActions({
    hostId,
    client,
    connState,
    worktreeId,
    prNumber,
    prRepo,
    queries
  })
  const textAction = useMobilePrTextAction({
    hostId,
    client,
    connState,
    worktreeId,
    prNumber,
    prRepo,
    queries
  })
  const clearTextError = textAction.clearError
  const { polling } = useMobilePrPolling({
    queries,
    state,
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

  const detailsOwner: PrTabScope = prScope
  const { checkDetails, ensureCheckDetail } = usePrCheckRunDetails({
    owner: detailsOwner,
    client,
    worktreeId,
    prRepo
  })

  const afterSheetCloseRef = useRef<(() => void) | null>(null)
  // A running Create holds its sheet up (the drawer refuses dismissal), so the run's result has somewhere to land.
  const [creatingPr, setCreatingPr] = useState(false)
  const [unlinking, setUnlinking] = useState(false)
  // An unlink failure belongs to the PR it was for, and the next menu action replaces it.
  const [unlinkFailure, setUnlinkFailure] = useState<{
    owner: PrTabScope
    message: string
  } | null>(null)
  const unlinkError = unlinkFailure?.owner === detailsOwner ? unlinkFailure.message : null
  const { setConfirm, takeConfirm } = requests
  const openConfirm = useCallback(
    (next: PrTabConfirm | null) => {
      setUnlinkFailure(null)
      setConfirm(next)
    },
    [setConfirm]
  )

  const unlink = useCallback(async (): Promise<void> => {
    if (!client || unlinking || prNumber === 0) {
      return
    }
    setUnlinking(true)
    setUnlinkFailure(null)
    try {
      const outcome = await unlinkMobilePr(client, worktreeId, prNumber)
      if (outcome.ok) {
        void refetch()
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
    sheet: requests.sheet,
    sheetRequest: requests.sheetRequest,
    ownsSheet: requests.ownsSheet,
    sheetInScope: requests.inScope,
    closeSheet: useCallback(() => setSheet(null), [setSheet]),
    closeSheetIf: requests.closeSheetIf,
    closeSheetThen: useCallback(
      (next: () => void) => {
        if (!requests.hasSheet()) {
          next()
          return
        }
        afterSheetCloseRef.current = next
        setSheet(null)
      },
      [requests.hasSheet, setSheet]
    ),
    polling,
    creatingPr,
    setCreatingPr,
    checkDetails,
    ensureCheckDetail,
    onSheetAfterClose: useCallback(() => {
      requests.retireDepartedSheet()
      const next = afterSheetCloseRef.current
      afterSheetCloseRef.current = null
      next?.()
    }, [requests.retireDepartedSheet]),
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
    confirm: requests.confirm,
    setConfirm: openConfirm,
    // A confirmation whose PR departed closes without acting; a current one acts on the PR it opened for.
    runConfirm: useCallback(() => {
      const kind = takeConfirm()
      if (kind === 'unlink') {
        void unlink()
      } else if (kind) {
        actions.updateState(kind === 'close' ? 'closed' : 'open')
      }
    }, [actions, takeConfirm, unlink]),
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
