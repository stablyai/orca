import { pendingSelectionHandle, pendingSelectionWantsHandle } from './pending-session-selection'
import { useEffect, useCallback } from 'react'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import type { TerminalFrame } from '../terminal/terminal-webview-messages'
import type { MobileSessionTabSwitchingModel } from './use-mobile-session-tab-switching'

export function useMobileSessionTerminalWebview(scope: MobileSessionTabSwitchingModel) {
  const {
    markdownDocs,
    fileDocs,
    terminalGestureInputBucketsRef,
    terminalGestureInputQueuesRef,
    terminalGestureInputInFlightRef,
    terminalRefs,
    terminalUnsubsRef,
    initializedHandlesRef,
    terminalDiagnosticsRef,
    webReadyHandlesRef,
    activeHandleRef,
    pendingSelectionRef,
    activeSessionTab,
    unsubscribeTerminal,
    subscribeToTerminal,
    nativeChatStream,
    readMarkdownTab,
    readFileTab,
    terminalFrameRef,
    notifyTerminalFrameHeight,
    notifyTerminalFrameWidth
  } = scope
  // Store the ref but subscribe only after web-ready so init cannot precede xterm loading.
  const setTerminalWebViewRef = useCallback((handle: string, ref: TerminalWebViewHandle | null) => {
    terminalDiagnosticsRef.current.webViewRef(handle, ref != null)
    if (ref) {
      terminalRefs.current.set(handle, ref)
    } else {
      terminalRefs.current.delete(handle)
      terminalGestureInputBucketsRef.current.delete(handle)
      const queued = terminalGestureInputQueuesRef.current.get(handle)
      if (queued?.timer) {
        clearTimeout(queued.timer)
      }
      terminalGestureInputQueuesRef.current.delete(handle)
      terminalGestureInputInFlightRef.current.delete(handle)
    }
  }, [])

  const handleTerminalWebReady = useCallback(
    (handle: string) => {
      const wasAlreadyReady = webReadyHandlesRef.current.has(handle)
      webReadyHandlesRef.current.add(handle)
      nativeChatStream.notifyWebReady(handle, wasAlreadyReady)
      terminalDiagnosticsRef.current.webViewReady(
        handle,
        wasAlreadyReady,
        handle === activeHandleRef.current
      )
      if (wasAlreadyReady && initializedHandlesRef.current.has(handle)) {
        // Reload loses the xterm buffer; request fresh scrollback.
        unsubscribeTerminal(handle)
        if (handle === activeHandleRef.current) {
          subscribeToTerminal(handle)
        }
        return
      }
      // Lagging snapshots can clear a new tab’s active handle; its pending marker still authorizes ready subscribe.
      const isIntendedActive =
        handle === activeHandleRef.current ||
        pendingSelectionWantsHandle(pendingSelectionRef.current, handle)
      if (isIntendedActive && !terminalUnsubsRef.current.has(handle)) {
        subscribeToTerminal(handle)
      }
    },
    [nativeChatStream, subscribeToTerminal, unsubscribeTerminal]
  )

  const subscribeIntendedActiveTerminal = useCallback(() => {
    const handle = pendingSelectionHandle(pendingSelectionRef.current) ?? activeHandleRef.current
    if (handle && !terminalUnsubsRef.current.has(handle)) {
      subscribeToTerminal(handle)
    }
  }, [activeHandleRef, pendingSelectionRef, subscribeToTerminal, terminalUnsubsRef])

  const notifyTerminalFrame = useCallback(
    (frame: TerminalFrame) => {
      // Imperative frame-height notification refits the PTY without rerendering SessionScreen.
      notifyTerminalFrameHeight(Math.round(frame.height))
      // Hidden pages report 0x0; preserve their last laid-out box.
      if (frame.width <= 0) {
        return
      }
      const previous = terminalFrameRef.current
      terminalFrameRef.current = frame
      if (!previous) {
        subscribeIntendedActiveTerminal()
      } else if (frame.width !== previous.width) {
        notifyTerminalFrameWidth()
      }
    },
    [
      notifyTerminalFrameHeight,
      notifyTerminalFrameWidth,
      subscribeIntendedActiveTerminal,
      terminalFrameRef
    ]
  )

  useEffect(() => {
    if (activeSessionTab?.type !== 'markdown') {
      return
    }
    const doc = markdownDocs.get(activeSessionTab.id)
    if (!doc) {
      void readMarkdownTab(activeSessionTab)
    }
  }, [activeSessionTab, markdownDocs, readMarkdownTab])

  useEffect(() => {
    if (activeSessionTab?.type !== 'file') {
      return
    }
    const doc = fileDocs.get(activeSessionTab.id)
    if (!doc) {
      void readFileTab(activeSessionTab)
    }
  }, [activeSessionTab, fileDocs, readFileTab])
  return {
    setTerminalWebViewRef,
    handleTerminalWebReady,
    notifyTerminalFrame
  }
}

export type MobileSessionTerminalWebviewModel = MobileSessionTabSwitchingModel &
  ReturnType<typeof useMobileSessionTerminalWebview>
