import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { GripVertical } from 'lucide-react-native'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useAnimatedReaction,
  useSharedValue,
  withSpring,
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
const ROW_SPRING = { damping: 28, stiffness: 350 }
const LONG_PRESS_ACTIVATION_MS = 200

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
  const restingBackground = colors.bgPanel

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
  const rowStyle = useAnimatedStyle(() => {
    const placed = ready && layout.value.ready && layout.value.measurementKey === measurementKey
    const placement = { position: placed ? ('absolute' as const) : ('relative' as const) }
    if (activeKey.value === rowKey) {
      return {
        ...placement,
        top: placed ? activeTop.value : 0,
        zIndex: 2,
        elevation: presentation === 'settings' ? 4 : 0,
        shadowOpacity: presentation === 'settings' ? 0.3 : 0,
        backgroundColor: presentation === 'settings' ? activeBackground : undefined,
        transform: [{ scale: presentation === 'settings' ? 1.02 : 1 }]
      }
    }
    return {
      ...placement,
      top: placed ? rowTop.value : 0,
      zIndex: 0,
      elevation: 0,
      shadowOpacity: 0,
      backgroundColor: presentation === 'settings' ? restingBackground : undefined,
      transform: [{ scale: 1 }]
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
