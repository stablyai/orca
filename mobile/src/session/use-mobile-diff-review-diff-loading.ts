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

// Retain loaded same-item diffs through transport blips so reconnect cannot erase the reader’s context.
export function useMobileDiffReviewDiffLoading(input: DiffLoadingInput): ReviewDiffState {
  const { client, connState, worktreeId, currentItem, screenState, setActiveHunkIndex } = input
  const [diffState, setDiffState] = useState<ReviewDiffState>({ kind: 'idle' })
  const hunkResetKeyRef = useRef<string | null>(null)
  // Depend on fields read, not screen-state identity, to avoid duplicate diff requests.
  const screenReady = screenState.kind === 'ready'
  const branchCompare = screenState.kind === 'ready' ? screenState.branchCompare : null

  useEffect(() => {
    // Only item changes reset hunk position; reconnect also reruns this effect.
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
          // Failed reconnect reads must not erase loaded diff content.
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
