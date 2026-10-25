import { useRef, useCallback } from 'react'
import type { MobileSessionNativeChatDictationModel } from './use-mobile-session-native-chat-dictation'

export function useMobileSessionTerminalSubscriptionFoundation(
  scope: MobileSessionNativeChatDictationModel
) {
  const {
    setCoveredStreamRevision,
    setTerminalKeyboardMetrics,
    terminalCwdRef,
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
      // Reset sequence state so a fresh subscription’s first snapshot cannot look stale.
      layoutSeqRef.current.delete(handle)
      // A new subscription needs its own snapshot before cell diffs can safely redraw.
      initializedHandlesRef.current.delete(handle)
      // Signal teardown when rendered lease was already false: batched subscribed/end or end alone would otherwise never rerun chat recovery.
      // An actually rendered lease already triggers recovery through state; another signal there would rerender the route twice.
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
  return {
    getTerminalRef,
    unsubscribeTerminal,
    unsubscribeTerminalRef,
    clearTerminalCache
  }
}

export type MobileSessionTerminalSubscriptionFoundationModel =
  MobileSessionNativeChatDictationModel &
    ReturnType<typeof useMobileSessionTerminalSubscriptionFoundation>
