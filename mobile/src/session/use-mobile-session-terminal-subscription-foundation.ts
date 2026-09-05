import { useRef, useCallback } from 'react'
import type { MobileSessionNativeChatDictationModel } from './use-mobile-session-native-chat-dictation'

export function useMobileSessionTerminalSubscriptionFoundation(
  scope: MobileSessionNativeChatDictationModel
) {
  const {
    setCoveredStreamRevision,
    setTerminalKeyboardMetrics,
    terminalCwdRef,
    viewportRef,
    viewportMeasuredRef,
    terminalRefs,
    terminalUnsubsRef,
    subscribingHandlesRef,
    leaseOnlyHandlesRef,
    initializedHandlesRef,
    terminalDiagnosticsRef,
    viewportResubscribeBudgetRef,
    webReadyHandlesRef,
    activeHandleRef,
    subscribeSeqRef,
    layoutSeqRef,
    terminalFrameHeightRef,
    nativeChatInputLeaseReadyRef,
    clearNativeChatInputLease,
    showNativeChatRef
  } = scope
  const getTerminalRef = useCallback((handle: string | null) => {
    return handle ? terminalRefs.current.get(handle) : undefined
  }, [])

  const unsubscribeTerminal = useCallback(
    (handle: string) => {
      terminalUnsubsRef.current.get(handle)?.()
      terminalUnsubsRef.current.delete(handle)
      subscribingHandlesRef.current.delete(handle)
      leaseOnlyHandlesRef.current.delete(handle)
      terminalDiagnosticsRef.current.terminalUnsubscribed(handle)
      subscribeSeqRef.current.set(handle, (subscribeSeqRef.current.get(handle) ?? 0) + 1)
      // Why: reset the high-water mark so a fresh subscription's first scrollback isn't dropped as stale.
      layoutSeqRef.current.delete(handle)
      // Why compare against the RENDERED lease: `clear` reports the drop from its
      // synchronous mirror, so a `subscribed`+`end` pair applied in one render batch
      // reports "dropped" while React only ever sees false → the effect never re-runs
      // and the composer stays locked (#10681). A dead PTY can also emit `end` with no
      // preceding `subscribed`, where the clear is a no-op for the same reason. Either
      // way the flip carries no signal, so bump. When the lease really was up on
      // screen, `leaseReady` already re-runs the effect and bumping too would
      // double-render this whole route on every chat open.
      const leaseWasOnScreen = nativeChatInputLeaseReadyRef.current
      const leaseDropped = clearNativeChatInputLease(handle)
      if (
        (!leaseDropped || !leaseWasOnScreen) &&
        showNativeChatRef.current &&
        handle === activeHandleRef.current
      ) {
        setCoveredStreamRevision((revision) => revision + 1)
      }
    },
    [clearNativeChatInputLease, nativeChatInputLeaseReadyRef, showNativeChatRef]
  )
  const unsubscribeTerminalRef = useRef(unsubscribeTerminal)
  // PTY event callbacks fire before passive effects flush, so they need the current unsubscribe.
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  unsubscribeTerminalRef.current = unsubscribeTerminal

  const clearTerminalCache = useCallback(() => {
    terminalUnsubsRef.current.forEach((unsub) => unsub())
    clearNativeChatInputLease()
    terminalUnsubsRef.current.clear()
    subscribingHandlesRef.current.clear()
    leaseOnlyHandlesRef.current.clear()
    initializedHandlesRef.current.clear()
    terminalDiagnosticsRef.current.clearTerminalCache()
    viewportResubscribeBudgetRef.current.clear()
    webReadyHandlesRef.current.clear()
    subscribeSeqRef.current.clear()
    layoutSeqRef.current.clear()
    terminalCwdRef.current.clear()
    setTerminalKeyboardMetrics(new Map())
    for (const term of terminalRefs.current.values()) {
      term.clear()
    }
  }, [clearNativeChatInputLease])

  // Why: measure the phone viewport once from the first TerminalWebView; dims ride every subscribe so the server auto-fits without a separate RPC.
  const measureViewportOnce = useCallback(
    async (handle: string) => {
      if (viewportMeasuredRef.current) {
        return
      }
      const dims = await getTerminalRef(handle)?.measureFitDimensions(
        terminalFrameHeightRef.current || undefined
      )
      terminalDiagnosticsRef.current.viewportMeasured(handle, dims, terminalFrameHeightRef.current)
      if (dims) {
        viewportRef.current = dims
        viewportMeasuredRef.current = true
      }
    },
    [getTerminalRef]
  )
  return {
    getTerminalRef,
    unsubscribeTerminal,
    unsubscribeTerminalRef,
    clearTerminalCache,
    measureViewportOnce
  }
}

export type MobileSessionTerminalSubscriptionFoundationModel =
  MobileSessionNativeChatDictationModel &
    ReturnType<typeof useMobileSessionTerminalSubscriptionFoundation>
