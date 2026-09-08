import { useRef, useCallback } from 'react'
import { useMobileNativeChatTerminalStream } from './use-mobile-native-chat-terminal-stream'
import type { MobileSessionTerminalSubscriptionModel } from './use-mobile-session-terminal-subscription'

export function useMobileSessionTerminalStreamDisplay(
  scope: MobileSessionTerminalSubscriptionModel
) {
  const {
    activeHandle,
    coveredStreamRevision,
    terminalModes,
    deviceTokenRef,
    viewportRef,
    terminalUnsubsRef,
    subscribingHandlesRef,
    leaseOnlyHandlesRef,
    initializedHandlesRef,
    webReadyHandlesRef,
    activeSessionTab,
    nativeChatInputLeaseReady,
    showNativeChat,
    unsubscribeTerminal,
    subscribeToTerminal,
    sessionTerminalOperations
  } = scope
  const nativeChatStream = useMobileNativeChatTerminalStream({
    showNativeChat,
    activeHandle,
    activeTabType: activeSessionTab?.type ?? null,
    leaseReady: nativeChatInputLeaseReady,
    streamRevision: coveredStreamRevision,
    subscriptionsRef: terminalUnsubsRef,
    subscribingRef: subscribingHandlesRef,
    leaseOnlyRef: leaseOnlyHandlesRef,
    webReadyRef: webReadyHandlesRef,
    initializedRef: initializedHandlesRef,
    subscribe: subscribeToTerminal,
    unsubscribe: unsubscribeTerminal
  })

  // Why: server does the resize and emits 'resized' on the existing subscription — no client-side state tracking needed.
  const toggleInFlightRef = useRef<Set<string>>(new Set())
  const toggleDisplayMode = useCallback(
    async (handle: string) => {
      if (!sessionTerminalOperations) {
        return
      }
      if (toggleInFlightRef.current.has(handle)) {
        return
      }
      const current = terminalModes.get(handle) ?? 'auto'
      // Why: 'phone' is an observed state, not a setting; the toggle only requests 'auto' or 'desktop'.
      const next: 'auto' | 'desktop' =
        current === 'auto' || current === 'phone' ? 'desktop' : 'auto'
      toggleInFlightRef.current.add(handle)
      try {
        await sessionTerminalOperations.setDisplayMode(
          handle,
          next,
          viewportRef.current,
          deviceTokenRef.current
        )
      } catch {
        // Mode change failed — server state unchanged, UI stays in sync.
      } finally {
        toggleInFlightRef.current.delete(handle)
      }
    },
    [sessionTerminalOperations, terminalModes]
  )
  return {
    nativeChatStream,
    toggleInFlightRef,
    toggleDisplayMode
  }
}

export type MobileSessionTerminalStreamDisplayModel = MobileSessionTerminalSubscriptionModel &
  ReturnType<typeof useMobileSessionTerminalStreamDisplay>
