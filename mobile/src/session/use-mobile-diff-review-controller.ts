import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileSourceControlSettings } from '../source-control/mobile-source-control-settings'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { getWorktreeLabel } from './worktree-label'
import { getUnsentMobileDiffComments } from './mobile-diff-comment-edit'
import {
  buildMobileDiffReviewQueue,
  filterMobileDiffReviewQueue,
  mobileDiffReviewCommentMatchesItem,
  type MobileDiffReviewQueueFilter
} from './mobile-diff-review-queue'
import { useMobileDiffReviewSelection } from './use-mobile-diff-review-selection'
import type { MobileDiffReviewInitialTarget } from './mobile-diff-review-positioning'
import { loadMobileDiffReviewSnapshot } from './mobile-diff-review-loaders'
import { loadMobileDiffReviewCommitSnapshot } from './mobile-diff-review-commit-loader'
import { useMobileDiffReviewDiffLoading } from './use-mobile-diff-review-diff-loading'
import { canOpenMobileBranchCompareDiff } from '../source-control/mobile-branch-compare'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import {
  NO_REVIEW_SHEETS,
  reduceReviewSheets,
  reviewComposer,
  reviewSheetIntents
} from './mobile-diff-review-sheets'
import { useMobileDiffReviewInteractions } from './use-mobile-diff-review-interactions'
import { resolveMobileAgentLaunchAvailability } from './mobile-agent-launch-availability'
import { useMobilePrSidebarController } from './use-mobile-pr-sidebar-controller'

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
    onOpenSession,
    onReconnect
  } = input
  const loadGenerationRef = useRef(0)
  const [screenState, setScreenState] = useState<ReviewScreenState>({ kind: 'loading' })
  // Bumped by every snapshot load (open, retry, after a git action), so the open file's diff reloads with it.
  const [snapshotVersion, setSnapshotVersion] = useState(0)
  const filter = initialFilter
  const [sheets, dispatchSheets] = useReducer(reduceReviewSheets, NO_REVIEW_SHEETS)
  const sheetIntents = useMemo(() => reviewSheetIntents(dispatchSheets), [])
  const composer = reviewComposer(sheets)
  const [composerBody, setComposerBody] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const worktreeLabel = getWorktreeLabel(name, worktreeId)
  const { compareAgainstUpstream } = useMobileSourceControlSettings(client, connState).settings

  const loadReviewData = useCallback(async () => {
    const generation = loadGenerationRef.current + 1
    loadGenerationRef.current = generation
    const isCurrent = () => generation === loadGenerationRef.current
    if (!worktreeId) {
      setScreenState({
        kind: 'error',
        message: translate('session.useDiffReviewController.missingWorktree', 'Missing worktree')
      })
      return
    }
    // Shells from before commit diffs drop the commit param when they mount this route themselves.
    if (initialFilter === 'commit' && !commitOid) {
      setScreenState({
        kind: 'unavailable',
        message: translate(
          'session.useDiffReviewController.commitMissing',
          'Update the Orca app to open commit files here.'
        )
      })
      return
    }
    // Keep an existing review through disconnects; only empty screens need the waiting state.
    const keepReady = (fallback: ReviewScreenState) => (prev: ReviewScreenState) =>
      prev.kind === 'ready' ? prev : fallback
    if (!client || connState !== 'connected') {
      setScreenState(
        keepReady({
          kind: 'error',
          message: translate(
            'session.useDiffReviewController.waitingForDesktop',
            'Waiting for desktop...'
          )
        })
      )
      return
    }
    setScreenState(keepReady({ kind: 'loading' }))
    try {
      const nextState = commitOid
        ? await loadMobileDiffReviewCommitSnapshot(client, worktreeId, commitOid)
        : await loadMobileDiffReviewSnapshot(client, worktreeId, compareAgainstUpstream)
      if (!isCurrent()) {
        return
      }
      setScreenState(nextState)
      setSnapshotVersion((version) => version + 1)
      setActionError(nextState.kind === 'ready' ? (nextState.branchError ?? null) : null)
    } catch (err) {
      if (isCurrent()) {
        // Failed reconnect reads must not destroy an already loaded review.
        setScreenState(
          keepReady({
            kind: 'error',
            message:
              err instanceof Error
                ? err.message
                : translate('session.useDiffReviewController.loadFailed', 'Unable to load review')
          })
        )
      }
    }
  }, [client, commitOid, compareAgainstUpstream, connState, initialFilter, worktreeId])

  useEffect(() => {
    void loadReviewData()
  }, [loadReviewData])

  const queue = useMemo(() => {
    if (screenState.kind !== 'ready') {
      return []
    }
    const branchEntries =
      screenState.branchCompare && canOpenMobileBranchCompareDiff(screenState.branchCompare.summary)
        ? (screenState.branchCompare.entries ?? [])
        : []
    return buildMobileDiffReviewQueue({
      worktreeId,
      statusEntries: screenState.status.entries,
      branchEntries,
      branchHeadOid: screenState.branchCompare?.summary.headOid,
      branchMergeBase: screenState.branchCompare?.summary.mergeBase,
      commitEntries: screenState.commit?.entries,
      comments: screenState.comments,
      reviewState: screenState.reviewState
    })
  }, [screenState, worktreeId])

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
    client,
    connState,
    worktreeId,
    currentItem,
    screenState,
    snapshotVersion
  })

  const commentsForCurrentItem = useMemo(() => {
    if (!currentItem || screenState.kind !== 'ready') {
      return []
    }
    return screenState.comments.filter((comment) =>
      mobileDiffReviewCommentMatchesItem(comment, currentItem)
    )
  }, [currentItem, screenState])

  const staleCommentIds = useMemo(
    () =>
      new Set(
        commentsForCurrentItem
          .filter(
            (comment) =>
              currentItem &&
              comment.diffIdentity !== undefined &&
              comment.diffIdentity !== currentItem.diffIdentity
          )
          .map((comment) => comment.id)
      ),
    [commentsForCurrentItem, currentItem]
  )

  const commentsByLine = useMemo(() => {
    const map = new Map<number, DiffComment[]>()
    for (const comment of commentsForCurrentItem) {
      const list = map.get(comment.lineNumber) ?? []
      list.push(comment)
      map.set(comment.lineNumber, list)
    }
    return map
  }, [commentsForCurrentItem])

  // Use git.status for PR head identity; branchCompare’s base ref is not the head.
  const prSidebarBranch = screenState.kind === 'ready' ? (screenState.status.branch ?? null) : null
  const prSidebarHeadSha =
    screenState.kind === 'ready'
      ? (screenState.status.head ?? screenState.branchCompare?.summary.headOid ?? null)
      : null
  const prSidebar = useMobilePrSidebarController({
    client,
    connState,
    worktreeId,
    branch: prSidebarBranch,
    headSha: prSidebarHeadSha
  })

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
    setComposerBody,
    setActionError,
    setBusyAction,
    sheets: sheetIntents,
    loadReviewData,
    onOpenSession,
    onReconnect
  })

  return {
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
