import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FlatList } from 'react-native'
import type { DiffComment } from '../../../src/shared/types'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { getWorktreeLabel } from './worktree-label'
import { getUnsentMobileDiffComments } from './mobile-diff-comment-edit'
import {
  buildMobileDiffReviewQueue,
  filterMobileDiffReviewQueue,
  mobileDiffReviewCommentMatchesItem,
  type MobileDiffReviewQueueFilter,
  type MobileDiffReviewQueueItem
} from './mobile-diff-review-queue'
import {
  loadMobileDiffReviewDiff,
  loadMobileDiffReviewSnapshot
} from './mobile-diff-review-loaders'
import { canOpenMobileBranchCompareDiff } from '../source-control/mobile-branch-compare'
import type {
  ComposerState,
  ReviewDiffLine,
  ReviewDiffState,
  ReviewScreenState,
  SendSheetState
} from './mobile-diff-review-screen-model'
import { useMobileDiffReviewInteractions } from './use-mobile-diff-review-interactions'
import { useMobilePrSidebarController } from './use-mobile-pr-sidebar-controller'

type ControllerInput = {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string
  worktreeId: string
  name: string
  initialFilter: MobileDiffReviewQueueFilter
  onOpenSession: () => void
  onReconnect: (hostId: string) => void | Promise<void>
}

export function useMobileDiffReviewController(input: ControllerInput) {
  const { client, connState, hostId, worktreeId, name, initialFilter, onOpenSession, onReconnect } =
    input
  const listRef = useRef<FlatList<ReviewDiffLine> | null>(null)
  const loadGenerationRef = useRef(0)
  const [screenState, setScreenState] = useState<ReviewScreenState>({ kind: 'loading' })
  const [diffState, setDiffState] = useState<ReviewDiffState>({ kind: 'idle' })
  const [filter, setFilter] = useState<MobileDiffReviewQueueFilter>(initialFilter)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [activeHunkIndex, setActiveHunkIndex] = useState<number | null>(null)
  const [composer, setComposer] = useState<ComposerState | null>(null)
  const [composerBody, setComposerBody] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [discardTarget, setDiscardTarget] = useState<MobileDiffReviewQueueItem | null>(null)
  const [showOverflow, setShowOverflow] = useState(false)
  const [sendSheet, setSendSheet] = useState<SendSheetState | null>(null)
  const [showCompletion, setShowCompletion] = useState(false)
  const worktreeLabel = getWorktreeLabel(name, worktreeId)

  const loadReviewData = useCallback(async () => {
    const generation = loadGenerationRef.current + 1
    loadGenerationRef.current = generation
    const isCurrent = () => generation === loadGenerationRef.current
    if (!worktreeId) {
      setScreenState({ kind: 'error', message: 'Missing worktree' })
      return
    }
    if (!client || connState !== 'connected') {
      setScreenState({ kind: 'error', message: 'Waiting for desktop...' })
      return
    }
    setScreenState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
    try {
      const nextState = await loadMobileDiffReviewSnapshot(client, worktreeId)
      if (!isCurrent()) {
        return
      }
      setScreenState(nextState)
      setActionError(nextState.kind === 'ready' ? (nextState.branchError ?? null) : null)
    } catch (err) {
      if (isCurrent()) {
        setScreenState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Unable to load review'
        })
      }
    }
  }, [client, connState, worktreeId])

  useEffect(() => {
    void loadReviewData()
  }, [loadReviewData])

  const queue = useMemo(() => {
    if (screenState.kind !== 'ready') {
      return []
    }
    const branchEntries =
      screenState.branchCompare && canOpenMobileBranchCompareDiff(screenState.branchCompare.summary)
        ? screenState.branchCompare.entries
        : []
    return buildMobileDiffReviewQueue({
      worktreeId,
      statusEntries: screenState.status.entries,
      branchEntries,
      branchHeadOid: screenState.branchCompare?.summary.headOid,
      branchMergeBase: screenState.branchCompare?.summary.mergeBase,
      comments: screenState.comments,
      reviewState: screenState.reviewState
    })
  }, [screenState, worktreeId])

  const filteredQueue = useMemo(() => filterMobileDiffReviewQueue(queue, filter), [filter, queue])
  const currentItem = filteredQueue[currentIndex] ?? null
  const reviewedCount = queue.filter((item) => item.isReviewed).length
  const unsentComments =
    screenState.kind === 'ready' ? getUnsentMobileDiffComments(screenState.comments) : []
  const reviewedUnstagedCount = queue.filter(
    (item) => item.scope === 'unstaged' && item.isReviewed && item.canStage
  ).length

  useEffect(() => {
    if (filteredQueue.length === 0) {
      setCurrentIndex(0)
      return
    }
    if (currentIndex >= filteredQueue.length) {
      setCurrentIndex(filteredQueue.length - 1)
    }
  }, [currentIndex, filteredQueue.length])

  useEffect(() => {
    setActiveHunkIndex(null)
    if (!currentItem || screenState.kind !== 'ready') {
      setDiffState({ kind: 'idle' })
      return
    }
    if (!client || connState !== 'connected') {
      setDiffState({ kind: 'error', itemKey: currentItem.key, message: 'Waiting for desktop...' })
      return
    }
    let stale = false
    setDiffState({ kind: 'loading', itemKey: currentItem.key })
    void loadMobileDiffReviewDiff({
      client,
      worktreeId,
      item: currentItem,
      branchCompare: screenState.branchCompare
    })
      .then((nextState) => {
        if (!stale) {
          setDiffState(nextState)
        }
      })
      .catch((err: unknown) => {
        if (!stale) {
          setDiffState({
            kind: 'error',
            itemKey: currentItem.key,
            message: err instanceof Error ? err.message : 'Unable to load diff'
          })
        }
      })
    return () => {
      stale = true
    }
  }, [client, connState, currentItem, screenState, worktreeId])

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

  // Head branch + SHA for the PR sidebar come from git.status (the review snapshot),
  // not the branchCompare base ref. headOid is the branch-compare fallback for the SHA.
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
    hostId,
    worktreeId,
    screenState,
    diffState,
    currentItem,
    queue,
    filteredQueue,
    filter,
    currentIndex,
    activeHunkIndex,
    composer,
    composerBody,
    listRef,
    setScreenState,
    setFilter,
    setCurrentIndex,
    setActiveHunkIndex,
    setComposer,
    setComposerBody,
    setActionError,
    setBusyAction,
    setSendSheet,
    setShowCompletion,
    loadReviewData,
    onOpenSession,
    onReconnect
  })

  return {
    ...interactions,
    ...prSidebar,
    // Exposed so the screen can thread the RPC client + worktree into the PR
    // sidebar's lazy check-detail fetches (U5) and mutation actions (U6).
    client,
    connState,
    worktreeId,
    prSidebarBranch,
    prSidebarHeadSha,
    actionError,
    activeHunkIndex,
    busyAction,
    commentsByLine,
    composer,
    composerBody,
    currentIndex,
    currentItem,
    diffState,
    discardTarget,
    fileNotes: commentsByLine.get(0) ?? [],
    filter,
    filteredQueue,
    listRef,
    queue,
    reviewedCount,
    reviewedUnstagedCount,
    screenState,
    sendSheet,
    setComposerBody,
    setDiscardTarget,
    setSendSheet,
    setShowCompletion,
    setShowOverflow,
    showCompletion,
    showOverflow,
    staleCommentIds,
    unsentComments,
    worktreeLabel
  }
}
