import { useMemo, useRef, useState } from 'react'
import { Platform, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { triggerSelection } from '../../platform/haptics/haptics'
import { colors, feedback, radii } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

export type MobileSliderProps = {
  value: number
  min: number
  max: number
  step?: number
  /** Each step the thumb crosses, so a preview can follow the drag. */
  onValueChange: (value: number) => void
  /** Once per drag, tap or accessibility step, for work that should not run every step. */
  onSlidingComplete?: (value: number) => void
  accessibilityLabel: string
  /** Spoken in place of the bare number, e.g. "13 points". */
  accessibilityValueText?: string
  disabled?: boolean
  testID?: string
}

const THUMB = 26
const TRACK_HEIGHT = 4
const HEIGHT = 44
const WEB = Platform.OS === 'web'

/**
 * A stepped slider drawn like iOS's: a thin track filled blue up to a white thumb.
 * JS-thread gestures: the page bundle has no worklet plugin, and steps are coarse enough to rerender.
 */
export function MobileSlider({
  value,
  min,
  max,
  step = 1,
  onValueChange,
  onSlidingComplete,
  accessibilityLabel,
  accessibilityValueText,
  disabled = false,
  testID
}: MobileSliderProps) {
  useMobileColorScheme()
  const [width, setWidth] = useState(0)
  const live = useRef({ value, width, onValueChange, onSlidingComplete })
  live.current.width = width
  live.current.onValueChange = onValueChange
  live.current.onSlidingComplete = onSlidingComplete
  live.current.value = value

  const gesture = useMemo(() => {
    const valueAt = (x: number): number => {
      const travel = live.current.width - THUMB
      if (travel <= 0) {
        return live.current.value
      }
      const fraction = Math.min(1, Math.max(0, (x - THUMB / 2) / travel))
      const stepped = min + Math.round((fraction * (max - min)) / step) * step
      return Math.min(max, Math.max(min, Number(stepped.toFixed(6))))
    }
    const moveTo = (x: number): void => {
      const next = valueAt(x)
      if (next !== live.current.value) {
        live.current.value = next
        triggerSelection()
        live.current.onValueChange(next)
      }
    }
    const complete = (): void => live.current.onSlidingComplete?.(live.current.value)
    // Horizontal-only activation leaves vertical drags to the screen's scroll view.
    const pan = Gesture.Pan()
      .runOnJS(true)
      .enabled(!disabled)
      .activeOffsetX([-4, 4])
      .failOffsetY([-12, 12])
      .onStart((event) => moveTo(event.x))
      .onUpdate((event) => moveTo(event.x))
      .onEnd(complete)
    const tap = Gesture.Tap()
      .runOnJS(true)
      .enabled(!disabled)
      .onEnd((event, success) => {
        if (success) {
          moveTo(event.x)
          complete()
        }
      })
    return Gesture.Race(pan, tap)
  }, [disabled, max, min, step])

  const fraction = max > min ? (Math.min(max, Math.max(min, value)) - min) / (max - min) : 0
  const thumbLeft = Math.max(0, width - THUMB) * fraction

  const stepTo = (target: number): void => {
    const next = Math.min(max, Math.max(min, Number(target.toFixed(6))))
    if (next !== value) {
      onValueChange(next)
      onSlidingComplete?.(next)
    }
  }
  const stepBy = (direction: 1 | -1): void => stepTo(value + direction * step)
  // React Native Web drops accessibility actions, so a page slider takes keys instead.
  const keyTarget = (key: string): number | null => {
    switch (key) {
      case 'ArrowRight':
      case 'ArrowUp':
        return value + step
      case 'ArrowLeft':
      case 'ArrowDown':
        return value - step
      case 'Home':
        return min
      case 'End':
        return max
      default:
        return null
    }
  }

  return (
    <GestureDetector gesture={gesture} touchAction="pan-y">
      <View
        style={[styles.root, disabled && styles.disabled]}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled }}
        accessibilityValue={{ min, max, now: value, text: accessibilityValueText }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'increment') {
            stepBy(1)
          } else if (event.nativeEvent.actionName === 'decrement') {
            stepBy(-1)
          }
        }}
        focusable={WEB && !disabled}
        onKeyDown={
          WEB && !disabled
            ? (event) => {
                const target = keyTarget(event.nativeEvent.key)
                if (target !== null) {
                  event.preventDefault()
                  stepTo(target)
                }
              }
            : undefined
        }
        testID={testID}
      >
        <View style={styles.track}>
          <View style={[styles.fill, { width: thumbLeft }]} />
        </View>
        <View style={[styles.thumb, { left: thumbLeft }]} />
      </View>
    </GestureDetector>
  )
}

const styles = themedStyleSheet(() => ({
  root: { height: HEIGHT, justifyContent: 'center' },
  disabled: { opacity: feedback.disabledOpacity },
  track: {
    height: TRACK_HEIGHT,
    marginHorizontal: THUMB / 2,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill,
    overflow: 'hidden'
  },
  fill: {
    height: TRACK_HEIGHT,
    backgroundColor: colors.accentBlue
  },
  thumb: {
    position: 'absolute',
    top: (HEIGHT - THUMB) / 2,
    width: THUMB,
    height: THUMB,
    borderRadius: radii.pill,
    backgroundColor: '#ffffff',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2
  }
}))
