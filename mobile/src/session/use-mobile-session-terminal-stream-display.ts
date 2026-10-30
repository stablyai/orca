import { useRef, useCallback } from 'react'
import { terminalDisplayModeSet } from './mobile-session-write-operations'
import { useMobileNativeChatTerminalStream } from './native-chat/use-mobile-native-chat-terminal-stream'
import type { MobileSessionTerminalSubscriptionModel } from './use-mobile-session-terminal-subscription'

export function useMobileSessionTerminalStreamDisplay(
  scope: MobileSessionTerminalSubscriptionModel
) {
  const {
    client,
    activeHandle,
    coveredStreamRevision,
    terminalModes,
    deviceTokenRef,
    viewportRef,
    terminalUnsubsRef,
    subscribingHandlesRef,
    leaseOnlyHandlesRef,
    webReadyHandlesRef,
    activeSessionTab,
    nativeChatInputLeaseReady,
    showNativeChat,
    unsubscribeTerminal,
    subscribeToTerminal
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
    subscribe: subscribeToTerminal,
    unsubscribe: unsubscribeTerminal
  })

  const toggleInFlightRef = useRef<Set<string>>(new Set())
  const toggleDisplayMode = useCallback(
    async (handle: string) => {
      if (!client) {
        return
      }
      if (toggleInFlightRef.current.has(handle)) {
        return
      }
      const current = terminalModes.get(handle) ?? 'auto'
      // Phone is observed state; request auto or desktop rather than persisting it.
      const next: 'auto' | 'desktop' =
        current === 'auto' || current === 'phone' ? 'desktop' : 'auto'
      toggleInFlightRef.current.add(handle)
      try {
        await terminalDisplayModeSet.request(client, {
          terminal: handle,
          mode: next,
          // Requesting auto explicitly takes the input floor and phone dimensions.
          ...(deviceTokenRef.current
            ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
            : {}),
          // Measure viewport live so pre-measure subscriptions can switch to auto successfully.
          ...(viewportRef.current && next === 'auto' ? { viewport: viewportRef.current } : {})
        })
      } catch {
        // Mode change failed — server state unchanged, UI stays in sync.
      } finally {
        toggleInFlightRef.current.delete(handle)
      }
    },
    [client, terminalModes]
  )
  return {
    nativeChatStream,
    toggleInFlightRef,
    toggleDisplayMode
  }
}

export type MobileSessionTerminalStreamDisplayModel = MobileSessionTerminalSubscriptionModel &
  ReturnType<typeof useMobileSessionTerminalStreamDisplay>
