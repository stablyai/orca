import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type Insets,
  type StyleProp,
  type TextStyle,
  type ViewStyle
} from 'react-native'
import { feedback } from '../../theme/mobile-theme'

/**
 * A button whose press sends something to the host and waits. The pending rule, shared by every
 * such control: the control that started the send shows `pending` (same size and colour, its label
 * swapped for a spinner, presses ignored) until the send settles; the send ticks `triggerSelection`
 * as it starts, and a failure buzzes through the chat's send-error reporter. Other controls the send
 * locks pass `disabled` and take the one disabled look.
 */
export function MobilePendingButton({
  label,
  pending = false,
  disabled = false,
  onPress,
  style,
  labelStyle,
  spinnerColor,
  hitSlop,
  accessibilityLabel,
  testID
}: {
  label: string
  pending?: boolean
  disabled?: boolean
  onPress: () => void
  style: StyleProp<ViewStyle>
  labelStyle: StyleProp<TextStyle>
  spinnerColor: string
  hitSlop?: number | Insets
  accessibilityLabel?: string
  testID?: string
}): React.JSX.Element {
  const off = disabled || pending
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: off, busy: pending }}
      // react-native-web maps aria-busy but not accessibilityState.busy.
      aria-busy={pending}
      disabled={off}
      onPress={onPress}
      hitSlop={hitSlop}
      testID={testID}
      style={({ pressed }) => [
        style,
        pressed && styles.pressed,
        disabled && !pending && styles.disabled
      ]}
    >
      {/* The label keeps the button's width while it spins. */}
      <Text style={[labelStyle, pending && styles.labelHidden]} numberOfLines={1}>
        {label}
      </Text>
      {pending ? (
        <ActivityIndicator size="small" color={spinnerColor} style={styles.spinner} />
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  pressed: { opacity: feedback.pressedOpacity },
  disabled: { opacity: feedback.disabledOpacity },
  labelHidden: { opacity: 0 },
  spinner: StyleSheet.absoluteFill
})
