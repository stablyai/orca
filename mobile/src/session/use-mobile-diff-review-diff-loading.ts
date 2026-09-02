import { useEffect, useRef, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { loadMobileDiffReviewDiff } from './mobile-diff-review-loaders'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import type { ReviewDiffState, ReviewScreenState } from './mobile-diff-review-screen-model'

type DiffLoadingInput = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  currentItem: MobileDiffReviewQueueItem | null
  screenState: ReviewScreenState
  setActiveHunkIndex: (index: number | null) => void
}

// Owns the diff body for the reviewed item. Split out of the review controller so the loaded diff
// can survive a transport blip: a drop re-runs this effect, and (F10) a diff already on screen for
// the same item stays there instead of being replaced by "Waiting for desktop..." or a spinner.
export function useMobileDiffReviewDiffLoading(input: DiffLoadingInput): ReviewDiffState {
  const { client, connState, worktreeId, currentItem, screenState, setActiveHunkIndex } = input
  const [diffState, setDiffState] = useState<ReviewDiffState>({ kind: 'idle' })
  const hunkResetKeyRef = useRef<string | null>(null)
  // Why: depend on the two fields this effect reads, not the screenState object —
  // an identity-only change must not restart the git.diff request.
  const screenReady = screenState.kind === 'ready'
  const branchCompare = screenState.kind === 'ready' ? screenState.branchCompare : null

  useEffect(() => {
    // Why (F10): a connection blip re-runs this effect; the reader's hunk position must
    // survive it and reset only when the reviewed item actually changes.
    const hunkKey = currentItem?.key ?? null
    if (hunkResetKeyRef.current !== hunkKey) {
      hunkResetKeyRef.current = hunkKey
      setActiveHunkIndex(null)
    }
    if (!currentItem || !screenReady) {
      setDiffState({ kind: 'idle' })
      return
    }
    const itemKey = currentItem.key
    const keepLoadedDiff = (fallback: ReviewDiffState) => (prev: ReviewDiffState) =>
      prev.kind === 'ready' && prev.itemKey === itemKey ? prev : fallback
    if (!client || connState !== 'connected') {
      setDiffState(keepLoadedDiff({ kind: 'error', itemKey, message: 'Waiting for desktop...' }))
      return
    }
    let stale = false
    setDiffState(keepLoadedDiff({ kind: 'loading', itemKey }))
    void loadMobileDiffReviewDiff({
      client,
      worktreeId,
      item: currentItem,
      branchCompare
    })
      .then((nextState) => {
        if (!stale) {
          setDiffState(nextState)
        }
      })
      .catch((err: unknown) => {
        if (!stale) {
          // Why (F10): a rejected reconnect refetch must not erase the diff on screen.
          setDiffState(
            keepLoadedDiff({
              kind: 'error',
              itemKey,
              message: err instanceof Error ? err.message : 'Unable to load diff'
            })
          )
        }
      })
    return () => {
      stale = true
    }
  }, [client, connState, currentItem, screenReady, branchCompare, setActiveHunkIndex, worktreeId])

  return diffState
}
