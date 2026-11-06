import { useEffect, useRef, useState } from 'react'
import { partialMatchKey, useIsFetching, type Query } from '@tanstack/react-query'
import {
  CALM_STATUS_IDLE,
  stepCalmStatusReveal,
  type CalmStatusReveal,
  type CalmStatusSchedule
} from '../../../src/shared/calm-status-reveal'
import { hostScopeKey, type HostQueryTarget } from './host-query-key'

// Quick revalidations never show, and a shown hint never flashes.
const REFRESH_HINT_SCHEDULE: CalmStatusSchedule = {
  revealDelayMs: 400,
  minVisibleMs: 400,
  healthyHoldMs: 0
}

// Empty screens show their own spinner, and streams keep their entry fresh without a fetch.
function isShownDataRefreshing(query: Query, target: Partial<HostQueryTarget>): boolean {
  return (
    query.state.data !== undefined &&
    query.meta?.streamBacked !== true &&
    query.isActive() &&
    partialMatchKey([query.queryKey[3]], [target])
  )
}

/** True while data a screen shows is being refreshed in the background. */
export function useHostRefreshHint(hostId: string, target: Partial<HostQueryTarget>): boolean {
  const refreshing =
    useIsFetching({
      queryKey: hostScopeKey(hostId),
      predicate: (query) => isShownDataRefreshing(query, target)
    }) > 0
  const revealRef = useRef<CalmStatusReveal>(CALM_STATUS_IDLE)
  const [visible, setVisible] = useState(false)
  const [wake, setWake] = useState(0)
  useEffect(() => {
    const step = stepCalmStatusReveal(
      revealRef.current,
      { down: refreshing, immediate: false, now: Date.now() },
      REFRESH_HINT_SCHEDULE
    )
    revealRef.current = step.next
    setVisible(step.visible)
    if (step.recheckInMs === null) {
      return
    }
    const timer = setTimeout(() => setWake((count) => count + 1), Math.max(0, step.recheckInMs))
    return () => clearTimeout(timer)
  }, [refreshing, wake])
  return visible
}
