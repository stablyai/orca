import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { useWindowBounds } from '../layout/window-bounds'
import {
  areTerminalViewportWidthsAligned,
  reduceTerminalFrameHeightRefit,
  resetTerminalKeyboardVisibilityForWidthChange,
  type TerminalFrameHeightRefitEvent,
  type TerminalFrameHeightRefitState
} from './terminal-viewport-refit-state'

export function useTerminalLayoutRefitTriggers({
  frameHeightStateRef,
  scheduleViewportRefit,
  tabStripVisible,
  terminalFrameWidth,
  textScale,
  viewportMeasuredRef,
  webViewViewportRef
}: {
  frameHeightStateRef: RefObject<TerminalFrameHeightRefitState>
  scheduleViewportRefit: (options?: { heightOriginated?: boolean }) => void
  tabStripVisible: boolean
  terminalFrameWidth: number
  textScale: number
  viewportMeasuredRef: RefObject<boolean>
  webViewViewportRef: RefObject<{ width: number; height: number } | null>
}) {
  const previousTabStripVisibleRef = useRef(tabStripVisible)
  useEffect(() => {
    if (previousTabStripVisibleRef.current === tabStripVisible) {
      return
    }
    previousTabStripVisibleRef.current = tabStripVisible
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [scheduleViewportRefit, tabStripVisible, viewportMeasuredRef])

  const { width: windowWidth, height: windowHeight } = useWindowBounds()
  const previousWindowBoundsRef = useRef({ width: windowWidth, height: windowHeight })
  useEffect(() => {
    const previous = previousWindowBoundsRef.current
    if (previous.width === windowWidth && previous.height === windowHeight) {
      return
    }
    previousWindowBoundsRef.current = { width: windowWidth, height: windowHeight }
    frameHeightStateRef.current = resetTerminalKeyboardVisibilityForWidthChange(
      frameHeightStateRef.current,
      previous.width,
      windowWidth
    )
    // Why: a height-only change while the IME is up is the keyboard itself; width changes always refit.
    if (previous.width === windowWidth && frameHeightStateRef.current.keyboardVisible) {
      return
    }
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [frameHeightStateRef, scheduleViewportRefit, viewportMeasuredRef, windowHeight, windowWidth])

  const previousTextScaleRef = useRef(textScale)
  useEffect(() => {
    if (previousTextScaleRef.current === textScale) {
      return
    }
    previousTextScaleRef.current = textScale
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [scheduleViewportRefit, textScale, viewportMeasuredRef])

  const previousFrameWidthRef = useRef(terminalFrameWidth)
  useEffect(() => {
    if (previousFrameWidthRef.current === terminalFrameWidth) {
      return
    }
    previousFrameWidthRef.current = terminalFrameWidth
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [scheduleViewportRefit, terminalFrameWidth, viewportMeasuredRef])

  const notifyFrameHeightEvent = useCallback(
    (event: TerminalFrameHeightRefitEvent) => {
      const transition = reduceTerminalFrameHeightRefit(frameHeightStateRef.current, event)
      frameHeightStateRef.current = transition.state
      if (!transition.shouldRefit) {
        return
      }
      viewportMeasuredRef.current = false
      scheduleViewportRefit({ heightOriginated: true })
    },
    [frameHeightStateRef, scheduleViewportRefit, viewportMeasuredRef]
  )
  const notifyTerminalFrameHeight = useCallback(
    (height: number) => notifyFrameHeightEvent({ type: 'frame-height', height }),
    [notifyFrameHeightEvent]
  )
  const notifyKeyboardVisibility = useCallback(
    (visible: boolean) => notifyFrameHeightEvent({ type: 'keyboard-visibility', visible }),
    [notifyFrameHeightEvent]
  )
  // Why: a hardware keyboard means no IME is covering the PTY; route through the reducer so a refit deferred while the IME was up flushes now.
  const notifyHardwareKeyboard = useCallback(
    () => notifyFrameHeightEvent({ type: 'keyboard-visibility', visible: false }),
    [notifyFrameHeightEvent]
  )
  const notifyWebViewViewport = useCallback(
    (width: number, height: number) => {
      webViewViewportRef.current = { width, height }
      if (!areTerminalViewportWidthsAligned(terminalFrameWidth, width)) {
        return
      }
      viewportMeasuredRef.current = false
      scheduleViewportRefit()
    },
    [scheduleViewportRefit, terminalFrameWidth, viewportMeasuredRef, webViewViewportRef]
  )

  return {
    notifyHardwareKeyboard,
    notifyKeyboardVisibility,
    notifyTerminalFrameHeight,
    notifyWebViewViewport
  }
}
