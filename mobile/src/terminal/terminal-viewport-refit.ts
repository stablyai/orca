import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { useWindowDimensions } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { TerminalWebViewHandle } from './TerminalWebView'
import {
  isTerminalUpdateViewportApplied,
  isTerminalViewportRefitTargetCurrent
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
  tabStripVisible: boolean
  // Why: terminal text size (font scale) — changing it changes the cell size, so
  // the PTY must be re-fitted to a new column count and reflowed.
  textScale: number
  // Why: on wide layouts a docked side panel takes a fixed slice of the row, so
  // opening/closing OR resizing it changes the terminal column width without any
  // window-dim or tab-strip change. Carries the dock's effective width (0 when no
  // dock) so a drag-resize re-fits too — the refit's 150ms debounce coalesces the
  // stream of drag widths into a single settle-time refit.
  dockWidth: number
  unsubscribeTerminal: (handle: string) => void
  subscribeToTerminal: (handle: string) => void
}

// Why: re-measure the phone viewport when layout-affecting state changes
// outside the subscribe path — the tab strip toggling visibility, and the
// window itself resizing (fold/unfold on foldables, orientation rotation,
// split-screen). Without the resize trigger, a PTY fitted on the folded
// cover screen stays at cover-screen cols after unfolding and the terminal
// renders in only part of the display (#4579's "cut in half" symptom).
export function useTerminalViewportRefit(options: TerminalViewportRefitOptions): void {
  const {
    activeHandleRef,
    terminalRefs,
    terminalFrameHeightRef,
    viewportRef,
    viewportMeasuredRef,
    clientRef,
    deviceTokenRef,
    initializedHandlesRef,
    tabStripVisible,
    textScale,
    dockWidth,
    unsubscribeTerminal,
    subscribeToTerminal
  } = options

  const refitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refitRunSeqRef = useRef(0)
  const disposedRef = useRef(false)
  const scheduleViewportRefit = useCallback(() => {
    if (refitTimerRef.current) {
      clearTimeout(refitTimerRef.current)
    }
    refitTimerRef.current = setTimeout(() => {
      refitTimerRef.current = null
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
        const prev = viewportRef.current
        if (prev && prev.cols === dims.cols && prev.rows === dims.rows) {
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
        if (rpc && deviceToken) {
          try {
            const response = await rpc.sendRequest('terminal.updateViewport', {
              terminal: handle,
              client: { id: deviceToken, type: 'mobile' as const },
              viewport: dims
            })
            if (isTerminalUpdateViewportApplied(response)) {
              rpc.updateTerminalSubscriptionViewport(handle, dims)
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
  }, [
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
  ])

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

  // Why: docking/undocking OR resizing a side panel on a wide layout changes the
  // terminal's column width (the dock takes a slice of the row) without any
  // window-dim or tab-strip change, so the cached viewport goes stale and the PTY
  // keeps the pre-change width. Mark un-measured and refit when the width changes.
  const prevDockWidthRef = useRef(dockWidth)
  useEffect(() => {
    if (prevDockWidthRef.current === dockWidth) {
      return
    }
    prevDockWidthRef.current = dockWidth
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [dockWidth, viewportMeasuredRef, scheduleViewportRefit])

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
}
