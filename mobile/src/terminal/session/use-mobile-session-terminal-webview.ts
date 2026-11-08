import type { terminalInputSend } from '../mobile-terminal-operations'
import { MobileTerminalInputSender } from '../mobile-terminal-input-sender'
import '../mobile-terminal-input-owner'
import type { TerminalInputEnqueueOptions } from '../mobile-terminal-input-owner'
import { TERMINAL_ORDERED_INPUT_CAPABILITY } from '../../../../src/shared/terminal/input/terminal-ordered-input'
import { useRouteCapability } from '../../worktree/use-workspace-client'
import { pendingSelectionWantsHandle } from '../../session/tabs/pending-session-selection'
import { useEffect, useCallback, useRef } from 'react'
import type { TerminalWebViewHandle } from '../terminal-webview-contract'
import type { TerminalFrame } from '../terminal-webview-messages'
import type { MobileSessionTabSwitchingModel } from '../../session/tabs/use-mobile-session-tab-switching'

export function useMobileSessionTerminalWebview(scope: MobileSessionTabSwitchingModel) {
  const {
    markdownDocs,
    client,
    hostId,
    worktreeId,
    fileDocs,
    terminalGestureInputBucketsRef,
    terminalGestureInputQueuesRef,
    terminalGestureInputInFlightRef,
    terminalRefs,
    terminalUnsubsRef,
    initializedHandlesRef,
    terminalResume,
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
    terminalTextScale,
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
  const orderedInputSupported = useRouteCapability(TERMINAL_ORDERED_INPUT_CAPABILITY)
  const inputSender = useRef(new MobileTerminalInputSender()).current
  useEffect(() => {
    const unsubscribe = client?.onStateChange((state) => {
      if (state !== 'connected') {
        inputSender.cancelAll()
      }
    })
    const unpath = client?.onConnectionPathChange?.(() => inputSender.cancelAll())
    return () => {
      unsubscribe?.()
      unpath?.()
      inputSender.cancelAll()
    }
  }, [client, hostId, worktreeId, inputSender])
  const sendTerminalOrderedInput = useCallback(
    (
      rpc: Parameters<typeof terminalInputSend.request>[0],
      params: Parameters<typeof terminalInputSend.request>[1],
      options?: Parameters<typeof terminalInputSend.request>[2],
      enqueue?: TerminalInputEnqueueOptions
    ) => {
      if (!client || rpc !== client) {
        return Promise.resolve({
          id: 'retired-input',
          ok: true as const,
          result: { send: { accepted: false } }
        })
      }
      return inputSender.request(client, params, options, orderedInputSupported, enqueue)
    },
    [client, inputSender, orderedInputSupported]
  )
  const sendTerminalUserInput = useCallback<typeof terminalInputSend.request>(
    (client, params, options) => {
      terminalRefs.current.get(params.terminal)?.scrollToBottom()
      return sendTerminalOrderedInput(client, params, options)
    },
    [terminalRefs, sendTerminalOrderedInput]
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
      // A pending resume would only append to the reloaded, empty buffer.
      const showedOutput =
        initializedHandlesRef.current.has(handle) || terminalResume.isCatchingUp(handle)
      if (wasAlreadyReady && showedOutput) {
        // Reload loses the xterm buffer; request fresh scrollback.
        unsubscribeTerminal(handle)
        terminalResume.forget(handle)
        if (visibleTerminalHandlesRef.current.includes(handle)) {
          subscribeToTerminal(handle)
        }
        return
      }
      if (wasAlreadyReady) {
        // A hidden document that reloaded lost its buffer too.
        terminalResume.forget(handle)
      }
      // Lagging snapshots can clear a new tab’s active handle; its pending marker still authorizes ready subscribe.
      const isIntendedActive =
        visibleTerminalHandlesRef.current.includes(handle) ||
        pendingSelectionWantsHandle(pendingSelectionRef.current, handle)
      if (isIntendedActive && !terminalUnsubsRef.current.has(handle)) {
        subscribeToTerminal(handle)
      }
    },
    [nativeChatStream, subscribeToTerminal, terminalResume, unsubscribeTerminal]
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
  const connStateSeenRef = useRef(connState)
  useEffect(() => {
    const visible = visibleTerminalHandlesRef.current
    // Cancel resumable streams on a lost connection, or the shell replays them as snapshots; connected resubscribes each from where its xterm stopped.
    const lostConnection = connStateSeenRef.current === 'connected' && connState !== 'connected'
    connStateSeenRef.current = connState
    for (const handle of terminalUnsubsRef.current.keys()) {
      if (!visible.includes(handle) || (lostConnection && terminalResume.canResume(handle))) {
        unsubscribeTerminal(handle)
      }
    }
    if (connState === 'connected') {
      for (const handle of visible) {
        subscribeToTerminal(handle)
      }
    }
  }, [visibleKey, connState, subscribeToTerminal, terminalResume, unsubscribeTerminal])

  // Hidden xterms reflow to a new text size on their own, so the host's record of their screens no longer fits them.
  useEffect(() => {
    terminalResume.forget()
  }, [terminalResume, terminalTextScale])

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
    sendTerminalOrderedInput,
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
