import { useCallback, useMemo, useReducer, useState } from 'react'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { DiffComment } from '../../../../src/shared/diff-comment-types'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { getWorktreeLabel } from '../../worktree/worktree-label'
import { getUnsentMobileDiffComments } from './mobile-diff-comment-edit'
import {
  buildMobileDiffReviewQueue,
  filterMobileDiffReviewQueue,
  type MobileDiffReviewQueueFilter
} from './mobile-diff-review-queue'
import { useMobileDiffReviewSelection } from './use-mobile-diff-review-selection'
import type { MobileDiffReviewInitialTarget } from './mobile-diff-review-positioning'
import { useMobileDiffReviewSnapshot } from './use-mobile-diff-review-snapshot'
import { useMobileDiffReviewDiffLoading } from './use-mobile-diff-review-diff-loading'
import { canOpenMobileBranchCompareDiff } from '../mobile-branch-compare'
import {
  NO_REVIEW_SHEETS,
  reduceReviewSheets,
  reviewComposer,
  reviewSheetIntents
} from './mobile-diff-review-sheets'
import { useMobileDiffReviewInteractions } from './use-mobile-diff-review-interactions'
import { resolveMobileAgentLaunchAvailability } from '../../session/agent-launch/mobile-agent-launch-availability'
import { useMobilePrSidebarController } from './use-mobile-pr-sidebar-controller'
import { useMobileDiffReviewGitHub } from './use-mobile-diff-review-github'
import { mobileDiffReviewThreadsForItem } from './mobile-diff-review-github'
import { mobileDiffReviewNotesForItem } from './mobile-diff-comments'
import { useMobileDiffReviewNoteDraft } from './use-mobile-diff-review-note-draft'
import { workspaceDraftRowKey } from '../../drafts/durable-draft-rows'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'

const NO_COMMENTS: readonly DiffComment[] = []

type ControllerInput = {
  client: RpcClient | null
  connState: ConnectionState
  hostCapabilities: readonly string[]
  hostStatusPending: boolean
  hostStatusReadable: boolean
  hostId: string
  worktreeId: string
  name: string
  initialFilter: MobileDiffReviewQueueFilter
  initialTarget: MobileDiffReviewInitialTarget | null
  /** Shows this commit's files instead of the worktree's changes. */
  commitOid: string | null
  /** A line of the tapped file to scroll to once, e.g. from a review thread's "Open in diff". */
  initialLine?: number | null
  onOpenSession: () => void
  /** Null on the page, where the shell owns the connection. */
  onReconnect: ((hostId: string) => void | Promise<void>) | null
}

export function useMobileDiffReviewController(input: ControllerInput) {
  useMobileTranslation()
  const {
    client,
    connState,
    hostCapabilities,
    hostStatusPending,
    hostStatusReadable,
    hostId,
    worktreeId,
    name,
    initialFilter,
    initialTarget,
    commitOid,
    initialLine = null,
    onOpenSession,
    onReconnect
  } = input
  const filter = initialFilter
  const [pendingLine, setPendingLine] = useState<number | null>(initialLine)
  const clearScrollToLine = useCallback(() => setPendingLine(null), [])
  const [sheets, dispatchSheets] = useReducer(reduceReviewSheets, NO_REVIEW_SHEETS)
  const sheetIntents = useMemo(() => reviewSheetIntents(dispatchSheets), [])
  const composer = reviewComposer(sheets)
  const executionHost = useWorkspaceExecutionHost()
  const noteDraft = useMobileDiffReviewNoteDraft({
    draftKey: workspaceDraftRowKey('reviewNote', { hostId, executionHost, worktreeId }, ''),
    openSheet: sheetIntents.openSheet
  })
  const { composerBody, setComposerBody } = noteDraft
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const worktreeLabel = getWorktreeLabel(name, worktreeId)
  const { screenState, setScreenState, statusRevision, target, loadReviewData } =
    useMobileDiffReviewSnapshot({
      client,
      connState,
      hostId,
      worktreeId,
      commitOid,
      filter,
      setActionError
    })

  // Use git.status for PR head identity; branchCompare’s base ref is not the head.
  const prSidebarBranch = screenState.kind === 'ready' ? (screenState.status.branch ?? null) : null
  const prSidebarHeadSha =
    screenState.kind === 'ready'
      ? (screenState.status.head ?? screenState.branchCompare?.summary.headOid ?? null)
      : null
  const prSidebar = useMobilePrSidebarController({
    hostId,
    client,
    connState,
    worktreeId,
    branch: prSidebarBranch,
    headSha: prSidebarHeadSha
  })

  const { github, applyViewed, setRemoteViewed, commentOnGitHub } = useMobileDiffReviewGitHub({
    hostId,
    client,
    connState,
    worktreeId,
    filter,
    screenState,
    prSidebar,
    setActionError
  })

  const queue = useMemo(() => {
    if (screenState.kind !== 'ready') {
      return []
    }
    const branchEntries =
      screenState.branchCompare && canOpenMobileBranchCompareDiff(screenState.branchCompare.summary)
        ? (screenState.branchCompare.entries ?? [])
        : []
    const built = buildMobileDiffReviewQueue({
      worktreeId,
      statusEntries: screenState.status.entries,
      branchEntries,
      branchHeadOid: screenState.branchCompare?.summary.headOid,
      branchMergeBase: screenState.branchCompare?.summary.mergeBase,
      commitEntries: screenState.commit?.entries,
      comments: screenState.comments,
      reviewState: screenState.reviewState
    })
    return applyViewed(built)
  }, [applyViewed, screenState, worktreeId])

  const filteredQueue = useMemo(() => filterMobileDiffReviewQueue(queue, filter), [filter, queue])
  const { currentIndex, currentItem, selectIndex, selectKey, moveSelection } =
    useMobileDiffReviewSelection(filteredQueue, initialTarget)
  const reviewedCount = useMemo(
    () => filteredQueue.filter((item) => item.isReviewed).length,
    [filteredQueue]
  )
  const unsentComments =
    screenState.kind === 'ready' ? getUnsentMobileDiffComments(screenState.comments) : []

  const diffState = useMobileDiffReviewDiffLoading({
    hostId,
    client,
    connState,
    target,
    currentItem,
    filteredQueue,
    currentIndex,
    screenState,
    statusRevision
  })

  const comments = screenState.kind === 'ready' ? screenState.comments : NO_COMMENTS
  const { commentsByLine, staleCommentIds } = useMemo(
    () => mobileDiffReviewNotesForItem(comments, currentItem),
    [comments, currentItem]
  )

  const interactions = useMobileDiffReviewInteractions({
    client,
    connState,
    hostCapabilities,
    hostId,
    worktreeId,
    screenState,
    currentItem,
    queue,
    filteredQueue,
    currentIndex,
    composer,
    composerBody,
    setScreenState,
    selectIndex,
    selectKey,
    moveSelection,
    remoteViewed: setRemoteViewed,
    noteDraft,
    setActionError,
    setBusyAction,
    sheets: sheetIntents,
    loadReviewData,
    onOpenSession,
    onReconnect
  })

  return {
    hostId,
    ...interactions,
    ...prSidebar,
    // A past commit has no branch context to find its pull request from.
    prSidebarIsGithubRepo: prSidebar.prSidebarIsGithubRepo && commitOid === null,
    ...sheetIntents,
    agentLaunchAvailability: resolveMobileAgentLaunchAvailability({
      hostCapabilities,
      statusPending: hostStatusPending,
      statusReadable: hostStatusReadable
    }),
    client,
    connState,
    worktreeId,
    prSidebarBranch,
    prSidebarHeadSha,
    github,
    // Threads only line up when the local branch is at the PR head; otherwise the file says so.
    ...mobileDiffReviewThreadsForItem(github, currentItem),
    commentOnGitHub,
    // Only the tapped file scrolls to the line, and only until it has.
    scrollToLine:
      pendingLine !== null &&
      initialTarget !== null &&
      currentItem?.filePath === initialTarget.filePath
        ? pendingLine
        : null,
    clearScrollToLine,
    actionError,
    busyAction,
    commentsByLine,
    composer,
    composerBody,
    currentIndex,
    currentItem,
    diffState,
    fileNotes: commentsByLine.get(0) ?? [],
    filter,
    filteredQueue,
    queue,
    reviewedCount,
    screenState,
    setComposerBody,
    sheet: sheets.requested,
    staleCommentIds,
    unsentComments,
    worktreeLabel
  }
}
