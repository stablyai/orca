import type { RefObject } from 'react'
import type { ConnectionState } from '../transport/types'
import type { TerminalWebViewHandle } from './TerminalWebView'

export const TERMINAL_FOREGROUND_RECOVERY_DELAY_MS = 120

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
}: TerminalForegroundRecoveryOptions): boolean {
  if (connStateRef.current !== 'connected') {
    return false
  }
  const initializedMountedHandles = Array.from(initializedHandlesRef.current).filter((handle) =>
    terminalRefs.current.has(handle)
  )
  if (initializedMountedHandles.length === 0) {
    return false
  }
  const handle = activeHandleRef.current
  const shouldRecoverActive =
    !!handle && terminalRefs.current.has(handle) && initializedHandlesRef.current.has(handle)

  // Why: inactive terminal WebViews stay mounted with opacity:0; iOS can blank
  // those backing stores too, so their next activation must accept scrollback.
  for (const initializedHandle of initializedMountedHandles) {
    initializedHandlesRef.current.delete(initializedHandle)
  }

  if (!shouldRecoverActive || !handle) {
    return true
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
  return true
}
