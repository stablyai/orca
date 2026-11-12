import type { LucideIcon } from 'lucide-react-native'
import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'
import { feedback, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useDrawerReducedMotion } from './bottom-drawer/bottom-drawer-constants'
import { SHEET_CURVE } from './sheet-motion-values'

// The width an action uncovers; a swipe past half of it settles open.
const ACTION_WIDTH = 84
const SWIPE_SETTLE_MS = 250
const DRAG_CLICK_WINDOW_MS = 400

export type SwipeRowAction = {
  label: string
  accessibilityLabel: string
  icon: LucideIcon
  background: string
  foreground: string
  onPress: () => void
}

/**
 * A row that slides to uncover an action: `leading` behind a right swipe, `trailing` behind a left
 * one. Tapping the uncovered action runs it. Rows without either action render as they are;
 * gaining or losing both remounts the row.
 */
export function SwipeRowActions({
  leading,
  trailing,
  enabled = true,
  children
}: {
  leading?: SwipeRowAction
  trailing?: SwipeRowAction
  enabled?: boolean
  /** Gets a wrapper for the row's press: a tap on a swiped row closes it instead. */
  children: (guardPress: (onPress: () => void) => () => void) => ReactNode
}) {
  useMobileColorScheme()
  const reducedMotion = useDrawerReducedMotion()
  const offset = useSharedValue(0)
  const start = useSharedValue(0)
  // When the last drag ended: on the web, releasing a mouse drag also clicks the row.
  const dragEndedAt = useSharedValue(0)
  const maxRight = leading ? ACTION_WIDTH : 0
  const maxLeft = trailing ? -ACTION_WIDTH : 0
  // Built per render: a module-level easing would run before a test's Reanimated mock can serve it.
  const settle = (to: number) => {
    'worklet'
    return withTiming(
      to,
      reducedMotion
        ? { duration: 0, reduceMotion: ReduceMotion.Never }
        : { duration: SWIPE_SETTLE_MS, easing: Easing.bezier(...SHEET_CURVE) }
    )
  }
  // Horizontal only, so the list keeps scrolling under a vertical drag.
  const pan = Gesture.Pan()
    .enabled(enabled)
    .activeOffsetX([-12, 12])
    .failOffsetY([-10, 10])
    .onBegin(() => {
      start.value = offset.value
    })
    .onUpdate((event) => {
      offset.value = Math.min(maxRight, Math.max(maxLeft, start.value + event.translationX))
    })
    .onEnd(() => {
      // oxlint-disable-next-line react/purity -- runs when the drag ends, never during render.
      dragEndedAt.value = Date.now()
      offset.value = settle(
        offset.value > ACTION_WIDTH / 2 ? maxRight : offset.value < -ACTION_WIDTH / 2 ? maxLeft : 0
      )
    })
  // Web has no worklet plugin; mapper hooks need this explicit dependency list.
  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }), [offset])
  // Hidden at rest, so the action can't show through a rounded group's antialiased corners.
  const actionsStyle = useAnimatedStyle(() => ({ opacity: offset.value === 0 ? 0 : 1 }), [offset])
  // A tap on an open row closes it rather than pressing the row.
  const guardPress = (onPress: () => void) => () => {
    // The click a drag release produces belongs to the drag, not to the row.
    if (Date.now() - dragEndedAt.value < DRAG_CLICK_WINDOW_MS) {
      return
    }
    if (offset.value !== 0) {
      offset.value = settle(0)
      return
    }
    onPress()
  }
  if (!leading && !trailing) {
    return children((onPress) => onPress)
  }
  const renderAction = (action: SwipeRowAction, side: 'leading' | 'trailing') => {
    const Icon = action.icon
    return (
      <Pressable
        style={({ pressed }) => [
          styles.action,
          side === 'leading' ? styles.leading : styles.trailing,
          { backgroundColor: action.background },
          pressed && styles.actionPressed
        ]}
        disabled={!enabled}
        onPress={() => {
          offset.value = settle(0)
          action.onPress()
        }}
        accessibilityRole="button"
        accessibilityLabel={action.accessibilityLabel}
      >
        <Icon size={17} color={action.foreground} strokeWidth={2.2} />
        <Text style={[styles.actionText, { color: action.foreground }]}>{action.label}</Text>
      </Pressable>
    )
  }
  return (
    <View>
      <Animated.View pointerEvents="box-none" style={[styles.actions, actionsStyle]}>
        {leading ? renderAction(leading, 'leading') : null}
        {trailing ? renderAction(trailing, 'trailing') : null}
      </Animated.View>
      {/* pan-y keeps the page scrolling vertically over the row on the web. */}
      <GestureDetector gesture={pan} touchAction="pan-y">
        <Animated.View style={rowStyle}>{children(guardPress)}</Animated.View>
      </GestureDetector>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  action: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: ACTION_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2
  },
  actions: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  leading: { left: 0 },
  trailing: { right: 0 },
  actionPressed: { opacity: feedback.pressedOpacity },
  actionText: { fontSize: typography.metaSize, fontWeight: '600' }
}))
