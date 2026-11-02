import { terminalInputSend } from '../terminal/mobile-terminal-operations'
import { pendingSelectionWantsHandle } from './pending-session-selection'
import { useEffect, useCallback, useRef } from 'react'
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
    activeHandle,
    terminals,
    setSplitTerminalHandles,
    visibleTerminalHandles,
    visibleTerminalHandlesRef,
    getTerminalPaneViewport,
    terminalPaneViewportsRef,
    connState,
    showNativeChat,
    switchTab,
    handleTerminalTap: focusTerminalTap,
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
  const sendTerminalUserInput = useCallback<typeof terminalInputSend.request>(
    (client, params, options) => {
      terminalRefs.current.get(params.terminal)?.scrollToBottom()
      return terminalInputSend.request(client, params, options)
    },
    [terminalRefs]
  )
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

  useEffect(() => {
    // Imperative handles change without layout events; inventory removal owns geometry cleanup.
    const liveHandles = new Set(terminals.map((terminal) => terminal.handle))
    for (const handle of terminalPaneViewportsRef.current.keys()) {
      if (!liveHandles.has(handle)) {
        terminalPaneViewportsRef.current.delete(handle)
      }
    }
  }, [terminals, terminalPaneViewportsRef])

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
        if (visibleTerminalHandlesRef.current.includes(handle)) {
          subscribeToTerminal(handle)
        }
        return
      }
      // Lagging snapshots can clear a new tab’s active handle; its pending marker still authorizes ready subscribe.
      const isIntendedActive =
        visibleTerminalHandlesRef.current.includes(handle) ||
        pendingSelectionWantsHandle(pendingSelectionRef.current, handle)
      if (isIntendedActive && !terminalUnsubsRef.current.has(handle)) {
        subscribeToTerminal(handle)
      }
    },
    [nativeChatStream, subscribeToTerminal, unsubscribeTerminal]
  )

  const notifyTerminalFrame = useCallback(
    (frame: TerminalFrame) => {
      terminalFrameRef.current = frame
    },
    [terminalFrameRef]
  )

  const notifyTerminalPaneFrame = useCallback(
    (handle: string, frame: TerminalFrame) => {
      if (frame.width <= 0 || frame.height <= 0) {
        return
      }
      const state = getTerminalPaneViewport(handle)
      const previous = state.terminalFrameRef.current
      state.terminalFrameRef.current = frame
      if (!previous || previous.width !== frame.width || previous.height !== frame.height) {
        state.viewportMeasuredRef.current = false
        if (visibleTerminalHandlesRef.current.includes(handle)) {
          if (!terminalUnsubsRef.current.has(handle)) {
            subscribeToTerminal(handle)
          }
          notifyTerminalFrameHeight(Math.round(frame.height))
          if (previous && previous.width !== frame.width) {
            notifyTerminalFrameWidth()
          }
        }
      }
    },
    [
      getTerminalPaneViewport,
      notifyTerminalFrameHeight,
      notifyTerminalFrameWidth,
      subscribeToTerminal
    ]
  )

  const canSplitTerminals =
    !!activeHandle &&
    terminals.some((terminal) => terminal.handle !== activeHandle) &&
    !showNativeChat
  const terminalSplitActive = !showNativeChat && visibleTerminalHandles.length === 2
  const toggleTerminalSplit = useCallback(() => {
    if (terminalSplitActive) {
      setSplitTerminalHandles(null)
      return
    }
    const companion = terminals.find((terminal) => terminal.handle !== activeHandle)
    if (activeHandle && companion) {
      setSplitTerminalHandles([activeHandle, companion.handle])
    }
  }, [activeHandle, terminalSplitActive, setSplitTerminalHandles, terminals])

  const focusFrameRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null)
  const handleTerminalInteraction = useCallback(
    (handle: string) => {
      if (!visibleTerminalHandlesRef.current.includes(handle)) {
        return
      }
      if (focusFrameRef.current !== null) {
        cancelAnimationFrame(focusFrameRef.current)
        focusFrameRef.current = null
      }
      if (activeHandleRef.current !== handle) {
        switchTab(handle)
      }
    },
    [switchTab]
  )
  const handleTerminalTap = useCallback(
    (handle: string) => {
      if (!visibleTerminalHandlesRef.current.includes(handle)) {
        return
      }
      handleTerminalInteraction(handle)
      focusFrameRef.current = requestAnimationFrame(() => {
        focusFrameRef.current = null
        if (activeHandleRef.current === handle) {
          focusTerminalTap(handle)
        }
      })
    },
    [focusTerminalTap, handleTerminalInteraction]
  )
  useEffect(
    () => () => {
      if (focusFrameRef.current !== null) {
        cancelAnimationFrame(focusFrameRef.current)
      }
    },
    []
  )

  const visibleKey = visibleTerminalHandles.join('\0')
  useEffect(() => {
    const visible = visibleTerminalHandlesRef.current
    for (const handle of terminalUnsubsRef.current.keys()) {
      if (!visible.includes(handle)) {
        unsubscribeTerminal(handle)
      }
    }
    if (connState === 'connected') {
      for (const handle of visible) {
        subscribeToTerminal(handle)
      }
    }
  }, [visibleKey, connState, subscribeToTerminal, unsubscribeTerminal])

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
    sendTerminalUserInput,
    setTerminalWebViewRef,
    handleTerminalWebReady,
    notifyTerminalFrame,
    notifyTerminalPaneFrame,
    canSplitTerminals,
    terminalSplitActive,
    toggleTerminalSplit,
    handleTerminalInteraction,
    handleTerminalTap
  }
}

export type MobileSessionTerminalWebviewModel = MobileSessionTabSwitchingModel &
  ReturnType<typeof useMobileSessionTerminalWebview>
