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
  clientRef: RefObject<RpcClient | null>
  deviceTokenRef: RefObject<string | null>
  initializedHandlesRef: RefObject<Set<string>>
  connState: ConnectionState
  tabStripVisible: boolean
  // Why: terminal text size (font scale) — changing it changes the cell size, so
  // the PTY must be re-fitted to a new column count and reflowed.
  textScale: number
  // Why: the terminal's measured frame width changes when a side panel docks/undocks
  // or EITHER sidebar is drag-resized (the left worktree sidebar shrinks the detail
  // pane; the right dock takes a slice of the row) — all without any window-dim or
  // tab-strip change. Carries that measured width so those resizes re-fit the PTY;
  // the 150ms debounce coalesces the stream of drag widths into one settle-time refit.
  terminalFrameWidth: number
  unsubscribeTerminal: (handle: string) => void
  subscribeToTerminal: (handle: string) => void
}

type TerminalViewportRefitNotifications = {
  notifyTerminalFrameHeight: (height: number) => void
  notifyKeyboardVisibility: (visible: boolean) => void
}

// Why: re-measure the phone viewport when layout-affecting state changes
// outside the subscribe path — the tab strip toggling visibility, and the
// window itself resizing (fold/unfold on foldables, orientation rotation,
// split-screen). Without the resize trigger, a PTY fitted on the folded
// cover screen stays at cover-screen cols after unfolding and the terminal
// renders in only part of the display (#4579's "cut in half" symptom).
export function useTerminalViewportRefit(
  options: TerminalViewportRefitOptions
): TerminalViewportRefitNotifications {
  const {
    activeHandleRef,
    terminalRefs,
    terminalFrameHeightRef,
    viewportRef,
    viewportMeasuredRef,
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
  // Why: marks the currently-armed timer as a height refit so its callback can
  // re-check the keyboard at fire time. Non-height refits (width/rotation and
  // the forced reconnect/foreground re-asserts) stay unguarded so they always run.
  const heightOriginatedRefitRef = useRef(false)
  const scheduleViewportRefit = useCallback(
    (options?: { heightOriginated?: boolean }) => {
      if (refitTimerRef.current) {
        clearTimeout(refitTimerRef.current)
      }
      heightOriginatedRefitRef.current = options?.heightOriginated ?? false
      refitTimerRef.current = setTimeout(() => {
        refitTimerRef.current = null
        // Why: a height refit deferred at keyboard-close can fire after the keyboard
        // reopened within the 150ms debounce; re-check and re-defer so we never
        // reflow the PTY mid-keystroke. Scoped via the height-originated flag.
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
          // Why: prefer the in-place viewport update RPC over the legacy
          // unsubscribe → subscribe cycle. This keeps the server-side
          // mobile subscriber record alive (no driver=idle blip on the
          // desktop banner; no false phone-fit baseline capture on the
          // re-subscribe). See docs/mobile-presence-lock.md.
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
                  // Why: updateViewport reflows the server PTY and re-streams only
                  // the visible screen, so the WebView's local xterm scrollback
                  // stays wrapped at the old width. Reflow it locally only when
                  // the server actually applied phone-fit; desktop mode records
                  // the viewport but leaves the PTY at desktop dims.
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

  // Why: the tab strip is hidden when only one terminal exists and shown
  // once a second is created. Crossing the 1↔2 boundary changes the
  // visible terminal area by ~40px, so the cached viewport dims in
  // viewportRef become stale. Mark the viewport as un-measured so the
  // next subscribe path's self-correcting loop (init → measure →
  // resubscribe-with-fresh-viewport) re-runs against the new layout.
  // Also schedule an explicit refit to cover the case where no new
  // subscribe is happening.
  const prevTabStripVisibleRef = useRef(tabStripVisible)
  useEffect(() => {
    if (prevTabStripVisibleRef.current === tabStripVisible) {
      return
    }
    prevTabStripVisibleRef.current = tabStripVisible
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [tabStripVisible, viewportMeasuredRef, scheduleViewportRefit])

  // Why: fold/unfold and rotation change the window dimensions without any
  // subscribe or tab-strip transition. The PTY must be re-fitted to the new
  // viewport or the terminal keeps the old grid (fit scale is capped at 1,
  // so a grown window leaves the surface pinned to a fraction of the screen).
  const { width: windowWidth, height: windowHeight } = useWindowDimensions()
  const prevWindowDimsRef = useRef({ width: windowWidth, height: windowHeight })
  useEffect(() => {
    const prev = prevWindowDimsRef.current
    if (prev.width === windowWidth && prev.height === windowHeight) {
      return
    }
    prevWindowDimsRef.current = { width: windowWidth, height: windowHeight }
    // Why: adjustResize can change only window height while the IME is open;
    // the frame-height notifier schedules one correction after it closes.
    if (prev.width === windowWidth && frameHeightRefitStateRef.current.keyboardVisible) {
      return
    }
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [windowWidth, windowHeight, viewportMeasuredRef, scheduleViewportRefit])

  // Why: the text size changed, so the WebView is re-rendering at a new font/cell
  // size. Re-measure and resize the PTY so the server reflows to the new column
  // count. The refit's own 150ms debounce gives the WebView a frame to apply the
  // new fontSize before we measure the resulting cell metrics.
  const prevTextScaleRef = useRef(textScale)
  useEffect(() => {
    if (prevTextScaleRef.current === textScale) {
      return
    }
    prevTextScaleRef.current = textScale
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [textScale, viewportMeasuredRef, scheduleViewportRefit])

  // Why: the terminal's measured frame width changes when a panel docks/undocks or
  // either sidebar is drag-resized — none of which touch the window dims or tab
  // strip — so the cached viewport goes stale and the PTY keeps the pre-resize
  // width. Mark un-measured and refit when the measured width changes.
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
  // Why: notify imperatively so layout churn does not rerender the full session;
  // a height change during typing is coalesced into one refit after keyboard close.
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
      // Why: the cached grid can match while the host PTY changed in background;
      // reasserting equal dimensions is the convergence signal after iOS resume.
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
    // Why: an in-place desktop upgrade may add updateViewport; reconnect is the
    // narrow boundary where an old-host method_not_found cache becomes stale.
    updateViewportCapabilityRef.current = 'unknown'
    // Why: reconnect can restore a PTY whose host-side size changed while the
    // socket was down, so equal cached dimensions still need reassertion.
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
