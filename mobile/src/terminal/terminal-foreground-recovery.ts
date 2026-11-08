import type { RefObject } from 'react'
import type { TerminalResumeState } from './session/terminal-stream-resume'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { TerminalWebViewHandle } from './TerminalWebView'

export const TERMINAL_FOREGROUND_RECOVERY_DELAY_MS = 120

// Deferred means disconnected at foreground; retry after reconnect or a blanked WKWebView stays stale.
export type TerminalForegroundRecoveryOutcome = 'recovered' | 'deferred' | 'skipped'

type TerminalForegroundRecoveryOptions = {
  activeHandleRef: RefObject<string | null>
  visibleTerminalHandlesRef?: RefObject<readonly string[]>
  terminalRefs: RefObject<Map<string, TerminalWebViewHandle>>
  initializedHandlesRef: RefObject<Set<string>>
  terminalResume: TerminalResumeState
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
  visibleTerminalHandlesRef,
  terminalRefs,
  initializedHandlesRef,
  terminalResume,
  connStateRef,
  unsubscribeTerminal,
  subscribeToTerminal,
  schedule,
  delayMs = TERMINAL_FOREGROUND_RECOVERY_DELAY_MS
}: TerminalForegroundRecoveryOptions): TerminalForegroundRecoveryOutcome {
  // A blanked WebView needs a snapshot: a resume would only append to it.
  terminalResume.forget()
  if (connStateRef.current !== 'connected') {
    return 'deferred'
  }
  const initializedMountedHandles = Array.from(initializedHandlesRef.current).filter((handle) =>
    terminalRefs.current.has(handle)
  )
  const visible =
    visibleTerminalHandlesRef?.current ?? (activeHandleRef.current ? [activeHandleRef.current] : [])
  const recovering = visible.filter(
    (handle) =>
      initializedMountedHandles.includes(handle) ||
      (terminalResume.isCatchingUp(handle) && terminalRefs.current.has(handle))
  )
  if (initializedMountedHandles.length === 0 && recovering.length === 0) {
    return 'skipped'
  }

  // Opacity-hidden WebViews can also lose iOS backing stores; their next activation must accept replay.
  for (const initializedHandle of initializedMountedHandles) {
    initializedHandlesRef.current.delete(initializedHandle)
  }

  for (const handle of recovering) {
    unsubscribeTerminal(handle)
    schedule(() => {
      if (connStateRef.current !== 'connected') {
        return
      }
      const stillVisible = visibleTerminalHandlesRef
        ? visibleTerminalHandlesRef.current.includes(handle)
        : activeHandleRef.current === handle
      if (stillVisible && terminalRefs.current.has(handle)) {
        subscribeToTerminal(handle)
      }
    }, delayMs)
  }
  return 'recovered'
}
