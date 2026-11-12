import { useRef, useState } from 'react'
import { View } from 'react-native'
import { colors, feedback, radii } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import type { MobileSessionOptionSliderTrackProps } from './MobileNativeChatSessionOptionSlider'

const THUMB = 20

export function MobileSessionOptionSliderTrack(
  props: MobileSessionOptionSliderTrackProps
): React.JSX.Element {
  useMobileColorScheme()
  const { count, value, disabled, onPreview, onCommit } = props
  const [width, setWidth] = useState(0)
  const draft = useRef<number | null>(null)
  const [preview, setPreview] = useState<number | null>(null)
  const shown = preview ?? value
  const range = Math.max(0, width - THUMB)
  const offset = shown === null ? null : (range * shown) / (count - 1)
  const previewAt = (x: number): number => {
    const index = Math.max(
      0,
      Math.min(count - 1, Math.round(((x - THUMB / 2) / range) * (count - 1)))
    )
    draft.current = index
    setPreview(index)
    onPreview(index)
    return index
  }
  const cancel = (): void => {
    draft.current = null
    setPreview(null)
    onPreview(null)
  }
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled }}
      accessibilityValue={{
        min: 0,
        max: count - 1,
        now: shown ?? undefined,
        text: props.valueText
      }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => {
        if (disabled) {
          return
        }
        const delta =
          event.nativeEvent.actionName === 'increment'
            ? 1
            : event.nativeEvent.actionName === 'decrement'
              ? -1
              : 0
        if (delta) {
          onCommit(Math.max(0, Math.min(count - 1, (value ?? (delta > 0 ? -1 : count)) + delta)))
        }
      }}
      style={[styles.touchTarget, disabled && styles.disabled]}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => !disabled && range > 0}
      onResponderGrant={(event) => {
        previewAt(event.nativeEvent.locationX)
      }}
      onResponderMove={(event) => {
        if (!disabled) {
          previewAt(event.nativeEvent.locationX)
        }
      }}
      onResponderRelease={() => {
        const picked = draft.current
        cancel()
        if (!disabled && picked !== null) {
          onCommit(picked)
        }
      }}
      onResponderTerminate={cancel}
    >
      <View pointerEvents="none" style={styles.rail}>
        {offset === null ? null : <View style={[styles.fill, { width: offset }]} />}
      </View>
      {offset === null ? null : (
        <View pointerEvents="none" style={[styles.thumb, { left: offset }]} />
      )}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  touchTarget: { height: 44, justifyContent: 'center' },
  disabled: { opacity: feedback.disabledOpacity },
  rail: {
    marginHorizontal: THUMB / 2,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill
  },
  fill: { height: 4, borderRadius: radii.pill, backgroundColor: colors.textPrimary },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: radii.pill,
    backgroundColor: colors.sheetGroup,
    borderWidth: 1,
    borderColor: colors.inputBorder
  }
}))
