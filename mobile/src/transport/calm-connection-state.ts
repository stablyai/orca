import { useEffect, useRef, useState } from 'react'
import {
  CALM_STATUS_IDLE,
  stepCalmStatusReveal,
  type CalmStatusReveal
} from '../../../src/shared/calm-status-reveal'
import type { ConnectionState } from './types'

// Hide short drops after a successful connection; show initial connects and refused pairings immediately.
export function stepCalmConnectionState(
  previous: CalmStatusReveal,
  input: {
    state: ConnectionState
    lastConnectedAt: number | null
    now: number
    /** On mount the drop already happened unseen; it began no earlier than the last connect. */
    since?: number | null
    shown?: ConnectionState
  }
): { next: CalmStatusReveal; presented: ConnectionState; recheckInMs: number | null } {
  // Why 'disconnected' waits too: an app suspend publishes it and the resume redials at once.
  const healing = input.state !== 'auth-failed' && input.lastConnectedAt !== null
  const step = stepCalmStatusReveal(previous, {
    down: input.state !== 'connected',
    immediate: !healing,
    now: input.now,
    since: input.since
  })
  return {
    next: step.next,
    presented: !step.visible
      ? 'connected'
      : input.state !== 'connected'
        ? input.state
        : (input.shown ?? 'connected'),
    recheckInMs: step.recheckInMs
  }
}

export function useCalmConnectionState(
  state: ConnectionState,
  lastConnectedAt: number | null
): ConnectionState {
  const revealRef = useRef<CalmStatusReveal>(CALM_STATUS_IDLE)
  const [presented, setPresented] = useState<ConnectionState>(
    () =>
      stepCalmConnectionState(CALM_STATUS_IDLE, {
        state,
        lastConnectedAt,
        now: Date.now(),
        since: lastConnectedAt
      }).presented
  )
  const [wake, setWake] = useState(0)
  const observedRef = useRef(false)
  const shownRef = useRef(presented)
  useEffect(() => {
    const step = stepCalmConnectionState(revealRef.current, {
      state,
      lastConnectedAt,
      now: Date.now(),
      // Use last connect for unseen mount-time drops; erring early exposes real outages promptly.
      since: observedRef.current ? null : lastConnectedAt,
      shown: shownRef.current
    })
    observedRef.current = true
    revealRef.current = step.next
    shownRef.current = step.presented
    setPresented(step.presented)
    if (step.recheckInMs === null) {
      return
    }
    const timer = setTimeout(() => setWake((count) => count + 1), Math.max(0, step.recheckInMs))
    return () => clearTimeout(timer)
  }, [state, lastConnectedAt, wake])
  return presented
}
