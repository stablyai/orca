import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { GripVertical } from 'lucide-react-native'
import Animated, {
  Easing,
  interpolateColor,
  runOnJS,
  useAnimatedStyle,
  useAnimatedReaction,
  useSharedValue,
  withSpring,
  withTiming,
  type DerivedValue,
  type SharedValue
} from 'react-native-reanimated'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { triggerMediumImpact } from '../platform/haptics'
import {
  type DragReorderLayout,
  orderedKeysFromDragReorderPositions,
  type DragReorderPositions
} from './drag-reorder-positions'
// Critically damped: Reanimated 4's default mass of 4 made the old damping/stiffness pair wobble.
const ROW_SPRING = { dampingRatio: 1, duration: 250 } as const
const LONG_PRESS_ACTIVATION_MS = 200
const LIFT_MS = 150

// Built per call: a module-level easing would run before a test's Reanimated mock can serve it.
function liftTo(value: 0 | 1) {
  'worklet'
  return withTiming(value, { duration: LIFT_MS, easing: Easing.out(Easing.cubic) })
}

export type DragSharedState = {
  layout: DerivedValue<DragReorderLayout & { measurementKey: string; ready: boolean }>
  initialPositions: SharedValue<DragReorderPositions>
  positions: SharedValue<DragReorderPositions>
  activeKey: SharedValue<string | null>
  activeTop: SharedValue<number>
  dragStartTop: SharedValue<number>
  dragStartScrollY: SharedValue<number>
  dragTranslationY: SharedValue<number>
  dragPointerAbsY: SharedValue<number>
}

export function DragReorderRow({
  rowKey,
  rowHeight,
  ready,
  measurementKey,
  movable,
  disabled,
  presentation,
  onMeasure,
  shared,
  scrollOffsetY,
  updateDragPosition,
  onDragActiveChange,
  onCommit,
  onAccessibilityMove,
  renderContent
}: {
  rowKey: string
  rowHeight?: number
  ready: boolean
  measurementKey: string
  movable: boolean
  disabled: boolean
  presentation: 'settings' | 'plain'
  onMeasure: (key: string, height: number) => void
  shared: DragSharedState
  scrollOffsetY: SharedValue<number>
  updateDragPosition: (key: string) => void
  onDragActiveChange: (active: boolean) => void
  onCommit: (orderedKeys: string[], movedId: string, dragged: boolean) => void
  onAccessibilityMove: (key: string, delta: number) => void
  renderContent: (handle: ReactNode) => ReactNode
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const {
    layout,
    initialPositions,
    positions,
    activeKey,
    activeTop,
    dragStartTop,
    dragStartScrollY,
    dragTranslationY,
    dragPointerAbsY
  } = shared
  // Read on the JS thread: capturing the live `colors` in a worklet would freeze it.
  const activeBackground = colors.bgRaised
  // Settings rows rest on their ListGroup's surface.
  const restingBackground = colors.sheetGroup

  // 0 rests, 1 is picked up: the lift eases in and out instead of snapping.
  const lift = useSharedValue(0)
  const pan = Gesture.Pan()
    .enabled(ready && movable && !disabled)
    .activateAfterLongPress(LONG_PRESS_ACTIVATION_MS)
    .shouldCancelWhenOutside(false)
    .onStart((event) => {
      initialPositions.value = { ...positions.value }
      dragStartTop.value = layout.value.tops[rowKey] ?? 0
      dragStartScrollY.value = scrollOffsetY.value
      dragTranslationY.value = 0
      dragPointerAbsY.value = event.absoluteY
      activeTop.value = dragStartTop.value
      activeKey.value = rowKey
      lift.value = liftTo(1)
      runOnJS(onDragActiveChange)(true)
      runOnJS(triggerMediumImpact)()
    })
    .onUpdate((event) => {
      if (activeKey.value !== rowKey) {
        return
      }
      dragTranslationY.value = event.translationY
      dragPointerAbsY.value = event.absoluteY
      updateDragPosition(rowKey)
    })
    .onFinalize((_event, success) => {
      if (activeKey.value !== rowKey) {
        return
      }
      activeKey.value = null
      lift.value = liftTo(0)
      if (success) {
        const orderedKeys = orderedKeysFromDragReorderPositions(positions.value)
        runOnJS(onCommit)(orderedKeys, rowKey, true)
      } else {
        positions.value = initialPositions.value
      }
      runOnJS(onDragActiveChange)(false)
    })

  const rowTop = useSharedValue(0)
  useAnimatedReaction(
    () => ({
      placed: ready && layout.value.ready && layout.value.measurementKey === measurementKey,
      measurementKey: layout.value.measurementKey,
      active: activeKey.value === rowKey,
      top: activeKey.value === rowKey ? activeTop.value : (layout.value.tops[rowKey] ?? 0)
    }),
    (current, previous) => {
      const placement =
        !current.placed || !previous?.placed || current.measurementKey !== previous.measurementKey
      if (placement || current.active) {
        rowTop.value = current.top
      } else if (previous && (current.top !== previous.top || previous.active)) {
        rowTop.value = withSpring(current.top, ROW_SPRING)
      }
    },
    [ready, layout, measurementKey, activeKey, rowKey, activeTop, rowTop]
  )
  // Rows sit at the top and move by transform, so a drag never lays the list out per frame.
  const rowStyle = useAnimatedStyle(() => {
    const placed = ready && layout.value.ready && layout.value.measurementKey === measurementKey
    const active = activeKey.value === rowKey
    const raised = presentation === 'settings' ? lift.value : 0
    const y = !placed ? 0 : active ? activeTop.value : rowTop.value
    return {
      position: placed ? ('absolute' as const) : ('relative' as const),
      top: 0,
      // Stay above neighbours while the lift eases off.
      zIndex: active || lift.value > 0 ? 2 : 0,
      elevation: 4 * raised,
      shadowOpacity: 0.3 * raised,
      backgroundColor:
        presentation === 'settings'
          ? interpolateColor(lift.value, [0, 1], [restingBackground, activeBackground])
          : undefined,
      transform: [{ translateY: y }, { scale: 1 + 0.02 * raised }]
    }
  }, [
    layout,
    activeKey,
    activeTop,
    rowKey,
    ready,
    measurementKey,
    presentation,
    rowTop,
    lift,
    activeBackground,
    restingBackground
  ])

  const handle = movable ? (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[styles.handle, presentation === 'plain' && styles.queueHandle]}
        accessible
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        accessibilityLabel={t('components.dragReorderRow.dragToReorder', 'Drag to reorder')}
        accessibilityHint={t(
          'components.dragReorderRow.reorderHint',
          'Use the move up and move down actions to reorder without dragging'
        )}
        accessibilityActions={[
          { name: 'moveUp', label: t('components.dragReorderRow.moveUp', 'Move up') },
          { name: 'moveDown', label: t('components.dragReorderRow.moveDown', 'Move down') }
        ]}
        onAccessibilityAction={(event) => {
          if (disabled) {
            return
          }
          if (event.nativeEvent.actionName === 'moveUp') {
            onAccessibilityMove(rowKey, -1)
          } else if (event.nativeEvent.actionName === 'moveDown') {
            onAccessibilityMove(rowKey, 1)
          }
        }}
        hitSlop={{
          top: 8,
          bottom: 8,
          left: 8,
          right: presentation === 'plain' ? 24 : 8
        }}
      >
        <GripVertical size={18} color={colors.textMuted} />
      </Animated.View>
    </GestureDetector>
  ) : null
  return (
    <Animated.View
      onLayout={(event) => onMeasure(rowKey, event.nativeEvent.layout.height)}
      style={[
        styles.row,
        presentation === 'plain' && { flexDirection: 'column', alignItems: 'stretch' },
        { height: rowHeight },
        rowStyle
      ]}
    >
      {presentation === 'plain' ? (
        renderContent(handle)
      ) : (
        <>
          <View style={styles.rowContent}>{renderContent(handle)}</View>
          {handle}
          <View style={styles.rowSeparator} />
        </>
      )}
    </Animated.View>
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8
  },
  rowContent: {
    flex: 1
  },
  handle: {
    alignSelf: 'stretch',
    justifyContent: 'center',
    paddingHorizontal: spacing.md
  },
  queueHandle: {
    paddingHorizontal: spacing.xs
  },
  rowSeparator: {
    position: 'absolute',
    bottom: 0,
    left: spacing.md,
    right: spacing.md,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle
  }
}))
