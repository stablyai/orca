import { useEffect, useRef, useState } from 'react'
import { useIsFetching, type Query } from '@tanstack/react-query'
import type { ConnectionState } from '../transport/types'
import { isHostNotConnectedError } from './host-query-errors'
import { hostScopeKey } from './host-query-key'

const REFRESH_HINT_DELAY_MS = 400
const REFRESH_HINT_MIN_VISIBLE_MS = 400

export type HostScreenState =
  | 'data'
  | 'empty-loading'
  | 'empty-connecting'
  | 'empty-offline'
  | 'empty-error'

// A screen with data shows it whatever the connection; an empty one says why, and spins only while a read can land.
export function hostScreenState(
  result: { data: unknown; error: unknown; isFetching: boolean },
  connState: ConnectionState
): HostScreenState {
  if (result.data !== undefined) {
    return 'data'
  }
  if (connState === 'disconnected' || connState === 'auth-failed') {
    return 'empty-offline'
  }
  if (connState !== 'connected') {
    return 'empty-connecting'
  }
  if (result.isFetching) {
    return 'empty-loading'
  }
  // The connected edge's refetch has not started yet.
  if (isHostNotConnectedError(result.error)) {
    return 'empty-connecting'
  }
  return result.error ? 'empty-error' : 'empty-loading'
}

// True while a shown screen revalidates in the background; quick refreshes never flash it.
export function useHostRefreshHint(scope: { hostId: string; worktree?: string }): boolean {
  const { hostId, worktree } = scope
  const refreshing =
    useIsFetching({
      queryKey: hostScopeKey(hostId),
      predicate: (query: Query) =>
        query.state.data !== undefined &&
        query.isActive() &&
        query.meta?.streamBacked !== true &&
        (worktree === undefined || readTargetWorktree(query) === worktree)
    }) > 0
  const [shown, setShown] = useState(false)
  const shownAtRef = useRef(0)
  useEffect(() => {
    if (refreshing === shown) {
      return
    }
    const delay = refreshing
      ? REFRESH_HINT_DELAY_MS
      : Math.max(0, shownAtRef.current + REFRESH_HINT_MIN_VISIBLE_MS - Date.now())
    const timer = setTimeout(() => {
      shownAtRef.current = Date.now()
      setShown(refreshing)
    }, delay)
    return () => clearTimeout(timer)
  }, [refreshing, shown])
  return shown
}

function readTargetWorktree(query: Query): unknown {
  const target = query.queryKey[3]
  return typeof target === 'object' && target !== null && 'worktree' in target
    ? target.worktree
    : undefined
}
