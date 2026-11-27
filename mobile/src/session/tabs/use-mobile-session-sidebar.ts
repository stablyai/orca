import { useEffect, useRef, useState } from 'react'
import { Keyboard } from 'react-native'
import { Gesture } from 'react-native-gesture-handler'
import {
  ReduceMotion,
  cancelAnimation,
  runOnJS,
  useSharedValue,
  withSpring,
  withTiming
} from 'react-native-reanimated'
import { useDrawerReducedMotion } from '../../components/bottom-drawer/bottom-drawer-constants'
import { REDUCED_MOTION_FADE_MS, SETTLE_SPRING } from '../../components/motion/sheet-motion-values'
import { useBackClaim } from '../../navigation/use-back-claim'
import { SESSION_DOCK_MIN_MAIN_WIDTH } from '../session-panel-host'
import { HOST_DOCK_MIN_WIDTH } from '../../storage/preferences'
import { triggerEdgeBump } from '../../platform/haptics/haptics'

/** How much of the session stays on screen, as a card at the left edge, while the sidebar is open. */
export const SIDEBAR_PEEK = 80
/** The docked column's width on wide screens. */
export const SIDEBAR_DOCKED_WIDTH = 320
const DRAG_SLOP = 10
const FLICK_VELOCITY = 500
// A release lands where the card would be this long after, at the finger's speed.
const RELEASE_PROJECTION_S = 0.2
// iOS's rubber band: past fully open the card follows ever less of the drag.
const RUBBER_BAND = 0.55
const DRAG_RELEASE_SPRING = { duration: 350, dampingRatio: 0.9, overshootClamping: true }
// On the web, releasing a drag also clicks what it ended over.
const DRAG_CLICK_WINDOW_MS = 400

function banded(progress: number): number {
  return progress <= 0 ? 0 : progress <= 1 ? progress : 2 - 1 / ((progress - 1) * RUBBER_BAND + 1)
}

/**
 * The tabs sidebar's state: one progress value (0 closed, 1 open) that the card, the panel and
 * their shadow all read, so a reversed drag can never leave them out of step. Docked, it's a
 * column that shows or hides with no motion.
 */
export function useMobileSessionSidebar(wideLayout: boolean) {
  const [stageWidth, setStageWidth] = useState(0)
  // Docks only where the session keeps a usable width beside it (the host list may share the row),
  // and a source control or files panel still docks beside the session as before.
  const docked =
    wideLayout &&
    stageWidth >= SIDEBAR_DOCKED_WIDTH + HOST_DOCK_MIN_WIDTH + SESSION_DOCK_MIN_MAIN_WIDTH
  const [open, setOpen] = useState(false)
  // Drawn from its first frame until it has closed, so a closed sidebar builds no rows.
  const [shown, setShown] = useState(false)
  const progress = useSharedValue(0)
  const width = useSharedValue(0)
  const dragStart = useSharedValue(0)
  const reducedMotion = useDrawerReducedMotion()
  const dragEndedAtRef = useRef(0)
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  })

  const hide = () => setShown(false)
  const settle = (target: 0 | 1, velocity?: number) => {
    setOpen(target === 1)
    if (target === 1) {
      setShown(true)
      // The keyboard belongs to the tab being set aside.
      Keyboard.dismiss()
    }
    if (docked) {
      progress.value = target
      if (target === 0) {
        hide()
      }
      return
    }
    const done = (finished?: boolean) => {
      'worklet'
      if (finished && target === 0) {
        runOnJS(hide)()
      }
    }
    // Never: under Reduce Motion this fade is what replaces the slide, so it must not be skipped too.
    progress.value = reducedMotion
      ? withTiming(
          target,
          { duration: REDUCED_MOTION_FADE_MS, reduceMotion: ReduceMotion.Never },
          done
        )
      : withSpring(
          target,
          velocity === undefined
            ? { ...SETTLE_SPRING, reduceMotion: ReduceMotion.Never }
            : { ...DRAG_RELEASE_SPRING, velocity, reduceMotion: ReduceMotion.Never },
          done
        )
  }
  const close = () => settle(0)
  const toggle = () => settle(openRef.current ? 0 : 1)

  // While open, Back (Android Back, the iOS edge swipe) closes the sidebar before leaving the workspace.
  useBackClaim(
    open && !docked
      ? () => {
          settle(0)
          return true
        }
      : null
  )

  // The card follows the finger 1:1 from where it was caught, and the release carries its speed.
  // One set of phases for every drag: the bar and card (gesture handler) and the page's own swipe.
  const dragBegin = () => {
    cancelAnimation(progress)
    dragStart.value = progress.value
    setShown(true)
  }
  const dragFollow = (translationX: number) => {
    const travel = Math.max(width.value - SIDEBAR_PEEK, 1)
    progress.value = banded(dragStart.value - translationX / travel)
  }
  const dragEnd = (velocityX: number, success: boolean) => {
    // oxlint-disable-next-line react/purity -- runs when the drag ends, never during render.
    dragEndedAtRef.current = Date.now()
    const travel = Math.max(width.value - SIDEBAR_PEEK, 1)
    const velocity = -velocityX / travel
    const projected = progress.value + velocity * RELEASE_PROJECTION_S
    const target: 0 | 1 = !success
      ? openRef.current
        ? 1
        : 0
      : Math.abs(velocityX) > FLICK_VELOCITY
        ? velocityX < 0
          ? 1
          : 0
        : projected > 0.5
          ? 1
          : 0
    if (target !== (openRef.current ? 1 : 0)) {
      triggerEdgeBump()
    }
    settle(target, velocity)
  }
  const drag = (activeOffsetX: number | [number, number]) =>
    Gesture.Pan()
      .runOnJS(true)
      .enabled(!docked)
      .activeOffsetX(activeOffsetX)
      .failOffsetY([-DRAG_SLOP, DRAG_SLOP])
      .onStart(dragBegin)
      .onUpdate((event) => dragFollow(event.translationX))
      .onEnd((event, success) => dragEnd(event.velocityX, success))

  return {
    docked,
    onStageLayout: (stage: number) => {
      width.value = stage
      setStageWidth(stage)
    },
    open,
    shown,
    progress,
    width,
    reducedMotion,
    toggle,
    close,
    /** Dragging the top bar left opens it; there's nothing else sideways in the bar. */
    barDrag: drag(-DRAG_SLOP),
    /** Dragging the card either way, once it's aside. */
    cardDrag: drag([-DRAG_SLOP, DRAG_SLOP]),
    /** A drag the page recognised itself (a swipe across the chat), driven through the same phases. */
    pageDrag: docked ? null : { begin: dragBegin, follow: dragFollow, end: dragEnd },
    /** A tap on the card that isn't the end of a drag. */
    tapIsDragEnd: () => Date.now() - dragEndedAtRef.current < DRAG_CLICK_WINDOW_MS
  }
}

export type MobileSessionSidebar = ReturnType<typeof useMobileSessionSidebar>
