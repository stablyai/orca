import { Gesture } from 'react-native-gesture-handler'
import {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedScrollHandler,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue
} from 'react-native-reanimated'
import { BOTTOM_DRAWER_HIDE_DURATION_MS } from './bottom-drawer-constants'
import { SETTLE_SPRING } from './sheet-motion-values'
import {
  bottomDrawerDismissMotion,
  bottomDrawerDragProgress,
  bottomDrawerOffset,
  bottomDrawerTravel,
  shouldDismissBottomDrawer
} from './bottom-drawer-drag-motion'

const TOP_SCROLL_EPSILON = 1

/**
 * The sheet's drag: the finger moves the same progress value that opens and closes it, so a grab
 * mid-open or mid-close takes the sheet where it is, and release carries the finger's speed.
 */
export function useBottomDrawerDrag(args: {
  progress: SharedValue<number>
  sheetHeight: SharedValue<number>
  screenHeight: number
  scrollOffsetY: SharedValue<number>
  onDismiss: () => void
}) {
  const { progress, sheetHeight, screenHeight, scrollOffsetY, onDismiss } = args
  const dragging = useSharedValue(false)
  const dragStartOffset = useSharedValue(0)

  const follow = (translationY: number) => {
    'worklet'
    const travel = bottomDrawerTravel(sheetHeight.value, screenHeight)
    if (!dragging.value) {
      cancelAnimation(progress)
      dragStartOffset.value = bottomDrawerOffset(progress.value, travel) - translationY
      dragging.value = true
    }
    progress.value = bottomDrawerDragProgress(dragStartOffset.value + translationY, travel)
  }

  const settle = (velocityY: number) => {
    'worklet'
    const travel = bottomDrawerTravel(sheetHeight.value, screenHeight)
    progress.value = withSpring(1, {
      ...SETTLE_SPRING,
      velocity: travel > 0 ? -velocityY / travel : 0
    })
  }

  const release = (velocityY: number) => {
    'worklet'
    if (!dragging.value) {
      return
    }
    dragging.value = false
    const travel = bottomDrawerTravel(sheetHeight.value, screenHeight)
    const offset = bottomDrawerOffset(progress.value, travel)
    if (!shouldDismissBottomDrawer(offset, velocityY, sheetHeight.value)) {
      settle(velocityY)
      return
    }
    const motion = bottomDrawerDismissMotion(
      offset,
      velocityY,
      travel,
      BOTTOM_DRAWER_HIDE_DURATION_MS
    )
    progress.value = withTiming(
      0,
      { duration: motion.duration, easing: Easing.bezier(motion.x1, motion.y1, 0.2, 1) },
      (finished) => {
        if (finished) {
          runOnJS(onDismiss)()
        }
      }
    )
  }

  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollOffsetY.value = Math.max(event.contentOffset.y, 0)
  })

  const scrollGesture = Gesture.Native()
  const handlePanGesture = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .simultaneousWithExternalGesture(scrollGesture)
    .onBegin(() => {
      dragging.value = false
    })
    .onUpdate((e) => follow(e.translationY))
    .onEnd((e) => release(e.velocityY))
  const contentPanGesture = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .simultaneousWithExternalGesture(scrollGesture)
    .onBegin(() => {
      dragging.value = false
    })
    .onUpdate((e) => {
      // Tall content scrolls back to its top before a downward drag takes the sheet.
      if (scrollOffsetY.value > TOP_SCROLL_EPSILON) {
        if (dragging.value) {
          dragging.value = false
          settle(0)
        }
        return
      }
      follow(e.translationY)
    })
    .onEnd((e) => release(e.velocityY))

  return { scrollHandler, scrollGesture, handlePanGesture, contentPanGesture }
}
