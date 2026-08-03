import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { AppState, Platform, useWindowDimensions, type AppStateStatus } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { TerminalWebViewHandle } from './TerminalWebView'
import { shouldRecoverTerminalOnAppStateChange } from './terminal-foreground-recovery'
import {
  isTerminalUpdateViewportApplied,
  isTerminalUpdateViewportUpdated,
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
  terminalFrameHeightRef: RefObject<number>
  viewportRef: RefObject<TerminalViewportDims | null>
  viewportMeasuredRef: RefObject<boolean>
  // Why: while native chat covers the active terminal, a refit would push phone dims into a PTY nobody on this device is viewing.
  nativeChatCoveredRef: RefObject<boolean>
  clientRef: RefObject<RpcClient | null>
  deviceTokenRef: RefObject<string | null>
  initializedHandlesRef: RefObject<Set<string>>
  connState: ConnectionState
  tabStripVisible: boolean
  // Why: text size (font scale); changing it changes cell size, so the PTY must be re-fitted to a new column count.
  textScale: number
  // Why: measured frame width; panel dock/undock or sidebar resize changes it with no window/tab change, so it re-fits the PTY.
  terminalFrameWidth: number
  unsubscribeTerminal: (handle: string) => void
  subscribeToTerminal: (handle: string) => void
}

type TerminalViewportRefitNotifications = {
  notifyTerminalFrameHeight: (height: number) => void
  notifyKeyboardVisibility: (visible: boolean) => void
}

// Why: re-measure on layout changes outside the subscribe path (tab strip, fold/rotate/resize), or a PTY renders "cut in half" (#4579).
export function useTerminalViewportRefit(
  options: TerminalViewportRefitOptions
): TerminalViewportRefitNotifications {
  const {
    activeHandleRef,
    terminalRefs,
    terminalFrameHeightRef,
    viewportRef,
    viewportMeasuredRef,
    nativeChatCoveredRef,
    clientRef,
    deviceTokenRef,
    initializedHandlesRef,
    connState,
    tabStripVisible,
    textScale,
    terminalFrameWidth,
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
  // Why: marks the armed timer as a height refit so its callback re-checks the keyboard; other refits always run unguarded.
  const heightOriginatedRefitRef = useRef(false)
  const scheduleViewportRefit = useCallback(
    (options?: { heightOriginated?: boolean }) => {
      if (refitTimerRef.current) {
        clearTimeout(refitTimerRef.current)
      }
      heightOriginatedRefitRef.current = options?.heightOriginated ?? false
      refitTimerRef.current = setTimeout(() => {
        refitTimerRef.current = null
        // Why: a height refit can fire after the keyboard reopened within the debounce; re-check so we never reflow the PTY mid-keystroke.
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
        // Why: the trigger already marked the viewport stale, and the return-to-terminal resubscribe re-measures — refitting now would resize a covered PTY.
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
          const dims = await ref.measureFitDimensions(terminalFrameHeightRef.current || undefined)
          if (!isCurrentTarget()) {
            return
          }
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
          // Why: prefer in-place updateViewport over resubscribe to keep the mobile subscriber record alive. See docs/mobile-presence-lock.md.
          const rpc = clientRef.current
          const deviceToken = deviceTokenRef.current
          if (rpc && deviceToken && updateViewportCapabilityRef.current !== 'unsupported') {
            try {
              const response = await rpc.sendRequest('terminal.updateViewport', {
                terminal: handle,
                client: { id: deviceToken, type: 'mobile' as const },
                viewport: dims
              })
              if (!isCurrentTarget()) {
                return
              }
              updateViewportCapabilityRef.current =
                resolveTerminalUpdateViewportCapability(response)
              if (isTerminalUpdateViewportUpdated(response)) {
                rpc.updateTerminalSubscriptionViewport(handle, dims)
                if (isTerminalUpdateViewportApplied(response)) {
                  // Why: updateViewport re-streams only the visible screen, so local scrollback stays wrapped at the old width — reflow it locally.
                  ref.reflow(dims.cols, dims.rows)
                }
                return
              }
            } catch {
              // Fall through to legacy resubscribe.
            }
          }
          if (!isCurrentTarget()) {
            return
          }
          unsubscribeTerminal(handle)
          initializedHandlesRef.current.delete(handle)
          subscribeToTerminal(handle)
        })()
      }, 150)
    },
    [
      activeHandleRef,
      terminalRefs,
      terminalFrameHeightRef,
      viewportRef,
      viewportMeasuredRef,
      nativeChatCoveredRef,
      clientRef,
      deviceTokenRef,
      initializedHandlesRef,
      unsubscribeTerminal,
      subscribeToTerminal
    ]
  )
  const scheduleForcedViewportRefit = useCallback(() => {
    forceNextRefitRef.current = true
    scheduleViewportRefit()
  }, [scheduleViewportRefit])

  // Why: the tab strip toggles at the 1↔2 terminal boundary (~40px area change), so the cached viewport goes stale.
  const prevTabStripVisibleRef = useRef(tabStripVisible)
  useEffect(() => {
    if (prevTabStripVisibleRef.current === tabStripVisible) {
      return
    }
    prevTabStripVisibleRef.current = tabStripVisible
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [tabStripVisible, viewportMeasuredRef, scheduleViewportRefit])

  // Why: fold/unfold and rotation change window dims with no subscribe/tab change; refit or the grid stays stale (fit capped at 1).
  const { width: windowWidth, height: windowHeight } = useWindowDimensions()
  const prevWindowDimsRef = useRef({ width: windowWidth, height: windowHeight })
  useEffect(() => {
    const prev = prevWindowDimsRef.current
    if (prev.width === windowWidth && prev.height === windowHeight) {
      return
    }
    prevWindowDimsRef.current = { width: windowWidth, height: windowHeight }
    // Why: adjustResize can change only window height while the IME is open; the frame-height notifier corrects once it closes.
    if (prev.width === windowWidth && frameHeightRefitStateRef.current.keyboardVisible) {
      return
    }
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [windowWidth, windowHeight, viewportMeasuredRef, scheduleViewportRefit])

  // Why: on text-size change the refit's 150ms debounce lets the WebView apply the new fontSize before we re-measure cell metrics.
  const prevTextScaleRef = useRef(textScale)
  useEffect(() => {
    if (prevTextScaleRef.current === textScale) {
      return
    }
    prevTextScaleRef.current = textScale
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [textScale, viewportMeasuredRef, scheduleViewportRefit])

  // Why: panel dock/undock or sidebar resize changes frame width with no window/tab change, so the cached viewport goes stale.
  const prevFrameWidthRef = useRef(terminalFrameWidth)
  useEffect(() => {
    if (prevFrameWidthRef.current === terminalFrameWidth) {
      return
    }
    prevFrameWidthRef.current = terminalFrameWidth
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [terminalFrameWidth, viewportMeasuredRef, scheduleViewportRefit])

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
  // Why: notify imperatively so layout churn doesn't rerender the full session.
  const notifyTerminalFrameHeight = useCallback(
    (height: number) => notifyFrameHeightRefitEvent({ type: 'frame-height', height }),
    [notifyFrameHeightRefitEvent]
  )
  const notifyKeyboardVisibility = useCallback(
    (visible: boolean) => notifyFrameHeightRefitEvent({ type: 'keyboard-visibility', visible }),
    [notifyFrameHeightRefitEvent]
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
      // Why: cached grid can match while the host PTY changed in background; reassert equal dims to converge after iOS resume.
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
    // Why: an in-place desktop upgrade may add updateViewport; reconnect is where the cached method_not_found goes stale.
    updateViewportCapabilityRef.current = 'unknown'
    // Why: reconnect can restore a PTY resized while the socket was down, so equal cached dims still need reassertion.
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

  return { notifyTerminalFrameHeight, notifyKeyboardVisibility }
}
