import { useEffect, useRef, type RefObject } from 'react'
import { AppState, Platform, type AppStateStatus } from 'react-native'
import type { ConnectionState } from '../transport/types'
import { shouldRecoverTerminalOnAppStateChange } from './terminal-foreground-recovery'
import type { TerminalUpdateViewportCapability } from './terminal-viewport-refit-state'

type TerminalViewportReassertionOptions = {
  connState: ConnectionState
  viewportMeasuredRef: RefObject<boolean>
  updateViewportCapabilityRef: RefObject<TerminalUpdateViewportCapability>
  scheduleForcedViewportRefit: () => void
}

// Why: the host PTY can change while the phone is backgrounded or offline, so these refits resend dims the cache already holds.
export function useTerminalViewportReassertion(options: TerminalViewportReassertionOptions) {
  const {
    connState,
    viewportMeasuredRef,
    updateViewportCapabilityRef,
    scheduleForcedViewportRefit
  } = options

  useEffect(() => {
    if (Platform.OS !== 'ios') {
      return
    }
    let previousAppState: AppStateStatus | null = AppState.currentState
    const sub = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      const shouldRefit = shouldRecoverTerminalOnAppStateChange(
        previousAppState,
        nextAppState,
        Platform.OS
      )
      previousAppState = nextAppState
      if (!shouldRefit) {
        return
      }
      // Why: cached grid can match while the host PTY changed in background; reassert equal dims to converge after iOS resume.
      viewportMeasuredRef.current = false
      scheduleForcedViewportRefit()
    })
    return () => sub.remove()
  }, [viewportMeasuredRef, scheduleForcedViewportRefit])

  const previousConnStateRef = useRef(connState)
  useEffect(() => {
    const previous = previousConnStateRef.current
    previousConnStateRef.current = connState
    if (previous === 'connected' || connState !== 'connected') {
      return
    }
    // Why: an in-place desktop upgrade may add updateViewport; reconnect is where the cached method_not_found goes stale.
    updateViewportCapabilityRef.current = 'unknown'
    // Why: reconnect can restore a PTY resized while the socket was down, so equal cached dims still need reassertion.
    viewportMeasuredRef.current = false
    scheduleForcedViewportRefit()
  }, [connState, viewportMeasuredRef, updateViewportCapabilityRef, scheduleForcedViewportRefit])
}
