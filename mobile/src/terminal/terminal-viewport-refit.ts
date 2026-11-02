import type { TerminalViewportRefitOptions } from './terminal-viewport-refit-options'
import { terminalPaneViewport } from '../session/mobile-terminal-pane-layout'
import { useCallback, useEffect, useRef } from 'react'
import { useWindowDimensions } from 'react-native'
import { useTerminalViewportReassertion } from './terminal-viewport-reassertion'
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

// Why: re-measure on layout changes outside the subscribe path (tab strip, fold/rotate/resize), or a PTY renders "cut in half" (#4579).
export function useTerminalViewportRefit(options: TerminalViewportRefitOptions) {
  const {
    activeHandleRef,
    visibleTerminalHandlesRef,
    terminalPaneViewportsRef,
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
    resizeForKeyboard,
    unsubscribeTerminal,
    subscribeToTerminal
  } = options

  const invalidateViewports = useCallback(() => {
    viewportMeasuredRef.current = false
    terminalPaneViewportsRef?.current.forEach((state) => {
      state.viewportMeasuredRef.current = false
    })
  }, [viewportMeasuredRef, terminalPaneViewportsRef])
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
    (trigger?: { heightOriginated?: boolean }) => {
      if (refitTimerRef.current) {
        clearTimeout(refitTimerRef.current)
      }
      heightOriginatedRefitRef.current = trigger?.heightOriginated ?? false
      refitTimerRef.current = setTimeout(() => {
        refitTimerRef.current = null
        // Height debounce can outlive keyboard reopening; recheck before reflowing the PTY.
        if (heightOriginatedRefitRef.current) {
          heightOriginatedRefitRef.current = false
          const decision = reduceTerminalFrameHeightRefit(
            frameHeightRefitStateRef.current,
            { type: 'refit-committed' },
            resizeForKeyboard
          )
          frameHeightRefitStateRef.current = decision.state
          if (!decision.shouldRefit) {
            return
          }
        }
        const runSeq = refitRunSeqRef.current + 1
        refitRunSeqRef.current = runSeq
        const handles =
          visibleTerminalHandlesRef?.current ??
          (activeHandleRef.current ? [activeHandleRef.current] : [])
        const forceRefit = forceNextRefitRef.current
        forceNextRefitRef.current = false
        handles.forEach((handle) => {
          const geometry = terminalPaneViewportsRef
            ? terminalPaneViewport(terminalPaneViewportsRef.current, handle)
            : options
          const { terminalFrameRef, viewportRef, viewportMeasuredRef } = geometry
          // Why: the trigger already marked the viewport stale, and the return-to-terminal resubscribe re-measures — refitting now would resize a covered PTY.
          if (nativeChatCoveredRef.current && handle === activeHandleRef.current) {
            return
          }
          const ref = terminalRefs.current.get(handle)
          if (!ref) {
            return
          }
          const isCurrentTarget = () =>
            isTerminalViewportRefitTargetCurrent({
              activeHandle: visibleTerminalHandlesRef
                ? visibleTerminalHandlesRef.current.includes(handle)
                  ? handle
                  : null
                : activeHandleRef.current,
              expectedHandle: handle,
              currentRef: terminalRefs.current.get(handle),
              expectedRef: ref,
              nativeChatCovered: nativeChatCoveredRef.current && handle === activeHandleRef.current,
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
            const prev = viewportRef.current
            if (!forceRefit && prev && prev.cols === dims.cols && prev.rows === dims.rows) {
              // A width change marked it unmeasured; the same grid still fits, so it is measured again.
              viewportMeasuredRef.current = true
              return
            }
            viewportRef.current = dims
            viewportMeasuredRef.current = true
            // Why: prefer in-place updateViewport over resubscribe to keep the mobile subscriber record alive. See docs/mobile-presence-lock.md.
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
                    // Why: updateViewport re-streams only the visible screen, so local scrollback stays wrapped at the old width — reflow it locally.
                    ref.reflow(dims.cols, dims.rows, frame)
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
            subscribeToTerminal(handle)
          })()
        })
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
      resizeForKeyboard,
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
    invalidateViewports()
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
    // Why: adjustResize can change only window height while the IME is open; defer it unless the user opted into keyboard resizing.
    if (
      !resizeForKeyboard &&
      prev.width === windowWidth &&
      frameHeightRefitStateRef.current.keyboardVisible
    ) {
      return
    }
    invalidateViewports()
    scheduleViewportRefit()
  }, [windowWidth, windowHeight, resizeForKeyboard, invalidateViewports, scheduleViewportRefit])

  // Why: a height-only window change suppressed while the option was off stays suppressed when it flips
  // mid-keyboard, leaving the PTY at stale dims; toggling the option resends it.
  const prevResizeForKeyboardRef = useRef(resizeForKeyboard)
  useEffect(() => {
    const was = prevResizeForKeyboardRef.current
    prevResizeForKeyboardRef.current = resizeForKeyboard
    if (was === resizeForKeyboard || !frameHeightRefitStateRef.current.keyboardVisible) {
      return
    }
    invalidateViewports()
    scheduleViewportRefit()
  }, [resizeForKeyboard, invalidateViewports, scheduleViewportRefit])

  // Debounce font changes so the WebView applies fontSize before native measures new cells.
  const prevTextScaleRef = useRef(textScale)
  useEffect(() => {
    if (prevTextScaleRef.current === textScale) {
      return
    }
    prevTextScaleRef.current = textScale
    invalidateViewports()
    scheduleViewportRefit()
  }, [textScale, viewportMeasuredRef, scheduleViewportRefit])

  // Dock/sidebar changes alter width without window changes; the refit keeps the grid if it still fits.
  const notifyTerminalFrameWidth = useCallback(() => {
    invalidateViewports()
    scheduleViewportRefit()
  }, [invalidateViewports, scheduleViewportRefit])

  const notifyFrameHeightRefitEvent = useCallback(
    (event: TerminalFrameHeightRefitEvent) => {
      const transition = reduceTerminalFrameHeightRefit(
        frameHeightRefitStateRef.current,
        event,
        resizeForKeyboard
      )
      frameHeightRefitStateRef.current = transition.state
      if (!transition.shouldRefit) {
        return
      }
      invalidateViewports()
      scheduleViewportRefit({ heightOriginated: true })
    },
    [resizeForKeyboard, invalidateViewports, scheduleViewportRefit]
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
      if (
        visibleTerminalHandlesRef
          ? !visibleTerminalHandlesRef.current.includes(handle)
          : handle !== activeHandleRef.current
      ) {
        return
      }
      invalidateViewports()
      scheduleViewportRefit()
    },
    [activeHandleRef, viewportMeasuredRef, scheduleViewportRefit]
  )

  useTerminalViewportReassertion({
    connState,
    invalidateViewports,
    updateViewportCapabilityRef,
    scheduleForcedViewportRefit
  })

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
