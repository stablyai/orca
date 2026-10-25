import type { RefObject } from 'react'
import type { ConnectionState } from '../transport/types'
import type { TerminalWebViewHandle } from './TerminalWebView'

export const TERMINAL_FOREGROUND_RECOVERY_DELAY_MS = 120

// Deferred means disconnected at foreground; retry after reconnect or a blanked WKWebView stays stale.
export type TerminalForegroundRecoveryOutcome = 'recovered' | 'deferred' | 'skipped'

type TerminalForegroundRecoveryOptions = {
  activeHandleRef: RefObject<string | null>
  terminalRefs: RefObject<Map<string, TerminalWebViewHandle>>
  initializedHandlesRef: RefObject<Set<string>>
  connStateRef: RefObject<ConnectionState>
  unsubscribeTerminal: (handle: string) => void
  subscribeToTerminal: (handle: string) => void
  schedule: (fn: () => void, ms: number) => void
  delayMs?: number
}

export function shouldRecoverTerminalOnAppStateChange(
  previousState: string | null | undefined,
  nextState: string,
  platform: string
): boolean {
  return (
    platform === 'ios' &&
    nextState === 'active' &&
    (previousState === 'background' || previousState === 'inactive')
  )
}

export function recoverActiveTerminalAfterForeground({
  activeHandleRef,
  terminalRefs,
  initializedHandlesRef,
  connStateRef,
  unsubscribeTerminal,
  subscribeToTerminal,
  schedule,
  delayMs = TERMINAL_FOREGROUND_RECOVERY_DELAY_MS
}: TerminalForegroundRecoveryOptions): TerminalForegroundRecoveryOutcome {
  if (connStateRef.current !== 'connected') {
    return 'deferred'
  }
  const initializedMountedHandles = Array.from(initializedHandlesRef.current).filter((handle) =>
    terminalRefs.current.has(handle)
  )
  if (initializedMountedHandles.length === 0) {
    return 'skipped'
  }
  const handle = activeHandleRef.current
  const shouldRecoverActive =
    !!handle && terminalRefs.current.has(handle) && initializedHandlesRef.current.has(handle)

  // Opacity-hidden WebViews can also lose iOS backing stores; their next activation must accept replay.
  for (const initializedHandle of initializedMountedHandles) {
    initializedHandlesRef.current.delete(initializedHandle)
  }

  if (!shouldRecoverActive || !handle) {
    return 'recovered'
  }

  unsubscribeTerminal(handle)
  schedule(() => {
    if (connStateRef.current !== 'connected') {
      return
    }
    if (activeHandleRef.current !== handle || !terminalRefs.current.has(handle)) {
      return
    }
    subscribeToTerminal(handle)
  }, delayMs)
  return 'recovered'
}
