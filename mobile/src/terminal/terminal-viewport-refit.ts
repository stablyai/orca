import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { AppState, Platform, useWindowDimensions, type AppStateStatus } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { TerminalWebViewHandle } from './TerminalWebView'
import type { TerminalFrame } from './terminal-webview-messages'
import { shouldRecoverTerminalOnAppStateChange } from './terminal-foreground-recovery'
import { terminalViewportUpdate } from './mobile-terminal-operations'
import {
  isTerminalViewportRefitTargetCurrent,
  reduceTerminalFrameHeightRefit,
  resolveTerminalUpdateViewportCapability,
  type TerminalFrameHeightRefitEvent,
  type TerminalFrameHeightRefitState,
  type TerminalUpdateViewportCapability
} from './terminal-viewport-refit-state'

export type TerminalViewportDims = { cols: number; rows: number }

type TerminalViewportRefitOptions = {
  activeHandleRef: RefObject<string | null>
  terminalRefs: RefObject<Map<string, TerminalWebViewHandle>>
  terminalFrameRef: RefObject<TerminalFrame | null>
  viewportRef: RefObject<TerminalViewportDims | null>
  viewportMeasuredRef: RefObject<boolean>
  // Covered native-chat terminals must not push phone dimensions into an unseen PTY.
  nativeChatCoveredRef: RefObject<boolean>
  clientRef: RefObject<RpcClient | null>
  deviceTokenRef: RefObject<string | null>
  connState: ConnectionState
  tabStripVisible: boolean
  textScale: number
  unsubscribeTerminal: (handle: string) => void
  subscribeToTerminal: (handle: string) => void
}

// Re-measure layout changes outside subscription so fold/rotate/strip changes cannot leave a clipped PTY.
export function useTerminalViewportRefit(options: TerminalViewportRefitOptions) {
  const {
    activeHandleRef,
    terminalRefs,
    terminalFrameRef,
    viewportRef,
    viewportMeasuredRef,
    nativeChatCoveredRef,
    clientRef,
    deviceTokenRef,
    connState,
    tabStripVisible,
    textScale,
    unsubscribeTerminal,
    subscribeToTerminal
  } = options

  const refitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refitRunSeqRef = useRef(0)
  const forceNextRefitRef = useRef(false)
  const disposedRef = useRef(false)
  const updateViewportCapabilityRef = useRef<TerminalUpdateViewportCapability>('unknown')
  const frameHeightRefitStateRef = useRef<TerminalFrameHeightRefitState>({
    frameHeight: 0,
    keyboardVisible: false,
    pending: false
  })
  const heightOriginatedRefitRef = useRef(false)
  const scheduleViewportRefit = useCallback(
    (options?: { heightOriginated?: boolean }) => {
      if (refitTimerRef.current) {
        clearTimeout(refitTimerRef.current)
      }
      heightOriginatedRefitRef.current = options?.heightOriginated ?? false
      refitTimerRef.current = setTimeout(() => {
        refitTimerRef.current = null
        // Height debounce can outlive keyboard reopening; recheck before reflowing the PTY.
        if (heightOriginatedRefitRef.current) {
          heightOriginatedRefitRef.current = false
          const decision = reduceTerminalFrameHeightRefit(frameHeightRefitStateRef.current, {
            type: 'refit-committed'
          })
          frameHeightRefitStateRef.current = decision.state
          if (!decision.shouldRefit) {
            return
          }
        }
        const runSeq = refitRunSeqRef.current + 1
        refitRunSeqRef.current = runSeq
        const handle = activeHandleRef.current
        if (!handle) {
          return
        }
        // Return-to-terminal resubscribe measures again; resizing now would affect a covered PTY.
        if (nativeChatCoveredRef.current) {
          return
        }
        const ref = terminalRefs.current.get(handle)
        if (!ref) {
          return
        }
        const isCurrentTarget = () =>
          isTerminalViewportRefitTargetCurrent({
            activeHandle: activeHandleRef.current,
            expectedHandle: handle,
            currentRef: terminalRefs.current.get(handle),
            expectedRef: ref,
            nativeChatCovered: nativeChatCoveredRef.current,
            disposed: disposedRef.current,
            runSeq,
            currentRunSeq: refitRunSeqRef.current
          })
        void (async () => {
          await ref.awaitReady()
          if (!isCurrentTarget()) {
            return
          }
          const frame = terminalFrameRef.current
          const dims = frame ? ref.fitDimensions(frame) : null
          if (!dims) {
            return
          }
          const forceRefit = forceNextRefitRef.current
          forceNextRefitRef.current = false
          const prev = viewportRef.current
          if (!forceRefit && prev && prev.cols === dims.cols && prev.rows === dims.rows) {
            return
          }
          viewportRef.current = dims
          viewportMeasuredRef.current = true
          // Prefer in-place updates to preserve subscriber presence ownership.
          const rpc = clientRef.current
          const deviceToken = deviceTokenRef.current
          if (rpc && deviceToken && updateViewportCapabilityRef.current !== 'unsupported') {
            try {
              const reply = await terminalViewportUpdate.request(rpc, {
                terminal: handle,
                client: { id: deviceToken, type: 'mobile' as const },
                viewport: dims
              })
              if (!isCurrentTarget()) {
                return
              }
              updateViewportCapabilityRef.current = resolveTerminalUpdateViewportCapability(reply)
              const outcome = terminalViewportUpdate.interpret(reply)
              if (outcome?.updated) {
                rpc.updateTerminalSubscriptionViewport(handle, dims)
                if (outcome.applied) {
                  // In-place updates replay only visible rows; locally rewrap old scrollback to match the new width.
                  ref.reflow(dims.cols, dims.rows, frame)
                }
                return
              }
            } catch {}
          }
          if (!isCurrentTarget()) {
            return
          }
          unsubscribeTerminal(handle)
          subscribeToTerminal(handle)
        })()
      }, 150)
    },
    [
      activeHandleRef,
      terminalRefs,
      terminalFrameRef,
      viewportRef,
      viewportMeasuredRef,
      nativeChatCoveredRef,
      clientRef,
      deviceTokenRef,
      unsubscribeTerminal,
      subscribeToTerminal
    ]
  )
  const scheduleForcedViewportRefit = useCallback(() => {
    forceNextRefitRef.current = true
    scheduleViewportRefit()
  }, [scheduleViewportRefit])

  const prevTabStripVisibleRef = useRef(tabStripVisible)
  useEffect(() => {
    if (prevTabStripVisibleRef.current === tabStripVisible) {
      return
    }
    prevTabStripVisibleRef.current = tabStripVisible
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [tabStripVisible, viewportMeasuredRef, scheduleViewportRefit])

  // Fold/rotation changes can occur without tab or subscription changes; refit the stale grid.
  const { width: windowWidth, height: windowHeight } = useWindowDimensions()
  const prevWindowDimsRef = useRef({ width: windowWidth, height: windowHeight })
  useEffect(() => {
    const prev = prevWindowDimsRef.current
    if (prev.width === windowWidth && prev.height === windowHeight) {
      return
    }
    prevWindowDimsRef.current = { width: windowWidth, height: windowHeight }
    // IME adjustResize may change height alone; correct via frame notification after close.
    if (prev.width === windowWidth && frameHeightRefitStateRef.current.keyboardVisible) {
      return
    }
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [windowWidth, windowHeight, viewportMeasuredRef, scheduleViewportRefit])

  // Debounce font changes so the WebView applies fontSize before native measures new cells.
  const prevTextScaleRef = useRef(textScale)
  useEffect(() => {
    if (prevTextScaleRef.current === textScale) {
      return
    }
    prevTextScaleRef.current = textScale
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [textScale, viewportMeasuredRef, scheduleViewportRefit])

  // Dock/sidebar changes alter width without window changes; ignore subpixel jitter if the current grid still fits.
  const notifyTerminalFrameWidth = useCallback(() => {
    const handle = activeHandleRef.current
    const frame = terminalFrameRef.current
    const fit = handle && frame ? terminalRefs.current.get(handle)?.fitDimensions(frame) : null
    const grid = viewportRef.current
    if (fit && grid && fit.cols === grid.cols && fit.rows === grid.rows) {
      return
    }
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [
    activeHandleRef,
    terminalFrameRef,
    terminalRefs,
    viewportRef,
    viewportMeasuredRef,
    scheduleViewportRefit
  ])

  const notifyFrameHeightRefitEvent = useCallback(
    (event: TerminalFrameHeightRefitEvent) => {
      const transition = reduceTerminalFrameHeightRefit(frameHeightRefitStateRef.current, event)
      frameHeightRefitStateRef.current = transition.state
      if (!transition.shouldRefit) {
        return
      }
      viewportMeasuredRef.current = false
      scheduleViewportRefit({ heightOriginated: true })
    },
    [viewportMeasuredRef, scheduleViewportRefit]
  )
  // Notify imperatively so layout churn cannot rerender the whole session.
  const notifyTerminalFrameHeight = useCallback(
    (height: number) => notifyFrameHeightRefitEvent({ type: 'frame-height', height }),
    [notifyFrameHeightRefitEvent]
  )
  const notifyKeyboardVisibility = useCallback(
    (visible: boolean) => notifyFrameHeightRefitEvent({ type: 'keyboard-visibility', visible }),
    [notifyFrameHeightRefitEvent]
  )

  // Renderer/DPR swaps can change cell metrics without changing the grid.
  const notifyTerminalCellBoxChange = useCallback(
    (handle: string) => {
      if (handle !== activeHandleRef.current) {
        return
      }
      viewportMeasuredRef.current = false
      scheduleViewportRefit()
    },
    [activeHandleRef, viewportMeasuredRef, scheduleViewportRefit]
  )

  useEffect(() => {
    if (Platform.OS !== 'ios') {
      return
    }
    let previousAppState: AppStateStatus | null = AppState.currentState
    const sub = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      const shouldRefit = shouldRecoverTerminalOnAppStateChange(
        previousAppState,
        nextAppState,
        Platform.OS
      )
      previousAppState = nextAppState
      if (!shouldRefit) {
        return
      }
      // Cached dimensions can match while the host resized offline; reassert them after iOS resume.
      viewportMeasuredRef.current = false
      scheduleForcedViewportRefit()
    })
    return () => sub.remove()
  }, [viewportMeasuredRef, scheduleForcedViewportRefit])

  const previousConnStateRef = useRef(connState)
  useEffect(() => {
    const previous = previousConnStateRef.current
    previousConnStateRef.current = connState
    if (previous === 'connected' || connState !== 'connected') {
      return
    }
    // Reconnect can reach an upgraded host; clear cached method-not-found capability.
    updateViewportCapabilityRef.current = 'unknown'
    // Reassert even equal cached dims because the PTY may have changed while disconnected.
    viewportMeasuredRef.current = false
    scheduleForcedViewportRefit()
  }, [connState, viewportMeasuredRef, scheduleForcedViewportRefit])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      refitRunSeqRef.current += 1
      if (refitTimerRef.current) {
        clearTimeout(refitTimerRef.current)
      }
    }
  }, [])

  return {
    notifyTerminalFrameHeight,
    notifyTerminalFrameWidth,
    notifyKeyboardVisibility,
    notifyTerminalCellBoxChange
  }
}
