import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { loadMobileDiffReviewDiff } from './mobile-diff-review-loaders'
import { shouldIgnoreTrimWhitespace } from '../../../src/shared/diff-whitespace'
import { useMobileSourceControlSettings } from '../source-control/mobile-source-control-settings'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import type { ReviewDiffState, ReviewScreenState } from './mobile-diff-review-screen-model'

type DiffLoadingInput = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  currentItem: MobileDiffReviewQueueItem | null
  screenState: ReviewScreenState
  /** Changes with each snapshot load; notes and viewed saves leave it alone. */
  snapshotVersion: number
}

// Retain loaded same-item diffs through transport blips so reconnect cannot erase the reader’s context.
export function useMobileDiffReviewDiffLoading(input: DiffLoadingInput): ReviewDiffState {
  useMobileTranslation()
  const { client, connState, worktreeId, currentItem, screenState, snapshotVersion } = input
  const [diffState, setDiffState] = useState<ReviewDiffState>({ kind: 'idle' })
  const { diffShowWhitespace } = useMobileSourceControlSettings(client, connState).settings
  // Depend on fields read, not screen-state identity, to avoid duplicate diff requests.
  const screenReady = screenState.kind === 'ready'
  const branchCompare = screenState.kind === 'ready' ? screenState.branchCompare : null
  const commit = screenState.kind === 'ready' ? (screenState.commit ?? null) : null
  // Reload only when what the loader reads changes; a viewed tick or note rebuilds the item object alone.
  const loadIdentity = currentItem
    ? [
        currentItem.key,
        currentItem.filePath,
        currentItem.oldPath ?? '',
        currentItem.status,
        currentItem.diffIdentity
      ].join('\0')
    : null
  const currentItemRef = useRef(currentItem)
  useLayoutEffect(() => {
    currentItemRef.current = currentItem
  })

  useEffect(() => {
    const currentItem = currentItemRef.current
    if (!currentItem || !screenReady) {
      setDiffState({ kind: 'idle' })
      return
    }
    const itemKey = currentItem.key
    const keepLoadedDiff = (fallback: ReviewDiffState) => (prev: ReviewDiffState) =>
      prev.kind === 'ready' && prev.itemKey === itemKey ? prev : fallback
    if (!client || connState !== 'connected') {
      setDiffState(
        keepLoadedDiff({
          kind: 'error',
          itemKey,
          message: translate(
            'session.useDiffReviewDiffLoading.waitingForDesktop',
            'Waiting for desktop...'
          )
        })
      )
      return
    }
    const controller = new AbortController()
    setDiffState(keepLoadedDiff({ kind: 'loading', itemKey }))
    void loadMobileDiffReviewDiff({
      client,
      worktreeId,
      item: currentItem,
      branchCompare,
      commit,
      signal: controller.signal,
      ignoreTrimWhitespace: shouldIgnoreTrimWhitespace(diffShowWhitespace)
    })
      .then((nextState) => {
        if (!controller.signal.aborted) {
          setDiffState(nextState)
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          // Failed reconnect reads must not erase loaded diff content.
          setDiffState(
            keepLoadedDiff({
              kind: 'error',
              itemKey,
              message:
                err instanceof Error
                  ? err.message
                  : translate('session.useDiffReviewDiffLoading.loadFailed', 'Unable to load diff')
            })
          )
        }
      })
    return () => {
      controller.abort()
    }
  }, [
    client,
    connState,
    loadIdentity,
    snapshotVersion,
    screenReady,
    branchCompare,
    commit,
    diffShowWhitespace,
    worktreeId
  ])

  // The effect reads after paint; until then the selected file is loading, not "Diff Unavailable" or the previous file.
  const settledForItem = diffState.kind !== 'idle' && diffState.itemKey === currentItem?.key
  return currentItem && screenReady && !settledForItem
    ? { kind: 'loading', itemKey: currentItem.key }
    : diffState
}
