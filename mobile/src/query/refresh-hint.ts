import { useEffect, useRef, useState } from 'react'
import {
  CALM_STATUS_IDLE,
  stepCalmStatusReveal,
  type CalmStatusReveal,
  type CalmStatusSchedule
} from '../../../src/shared/calm-status-reveal'

// Quick revalidations never show, and a shown hint never flashes.
const REFRESH_HINT_SCHEDULE: CalmStatusSchedule = {
  revealDelayMs: 400,
  minVisibleMs: 400,
  healthyHoldMs: 0
}

/**
 * Whether to show the header's refresh line. Pass `isRefetching` of the queries the screen shows:
 * it is false while a screen has no data (that screen spins instead), and stream-backed queries never fetch.
 */
export function useRefreshHint(refetching: boolean): boolean {
  const revealRef = useRef<CalmStatusReveal>(CALM_STATUS_IDLE)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const step = (): void => {
      const next = stepCalmStatusReveal(
        revealRef.current,
        { down: refetching, immediate: false, now: Date.now() },
        REFRESH_HINT_SCHEDULE
      )
      revealRef.current = next.next
      setVisible(next.visible)
      if (next.recheckInMs !== null) {
        timer = setTimeout(step, Math.max(0, next.recheckInMs))
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    step()
    return () => clearTimeout(timer)
  }, [refetching])
  return visible
}
