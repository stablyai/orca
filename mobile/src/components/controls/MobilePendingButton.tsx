import type { ReactNode } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type Insets,
  type StyleProp,
  type TextStyle,
  type ViewStyle
} from 'react-native'
import { feedback } from '../../theme/mobile-theme'

/**
 * A button whose press sends something to the host and waits. The pending rule, shared by every
 * such control: the control that started the send shows `pending` (same size and colour, its
 * content swapped for a spinner, presses ignored by default) until the send settles — a list row keeps its
 * content and shows the spinner after it, as list rows show progress; the send ticks
 * `triggerSelection` as it starts (`useMobilePendingControl` does both), and a failure buzzes
 * through the chat's send-error reporter. Other controls the send locks pass `disabled` and take
 * the one disabled look.
 */
export function MobilePendingButton({
  label,
  pending = false,
  pressWhilePending = false,
  disabled = false,
  onPress,
  onLongPress,
  style,
  labelStyle,
  numberOfLines = 1,
  icon,
  iconOnly = false,
  spinnerColor,
  disabledStyle,
  hitSlop,
  accessibilityLabel,
  accessibilityHint,
  testID,
  contentStyle,
  children
}: {
  /** Shown unless `iconOnly`; always the accessible name unless `accessibilityLabel` is given. */
  label: string
  pending?: boolean
  pressWhilePending?: boolean
  disabled?: boolean
  onPress: () => void
  onLongPress?: () => void
  style: StyleProp<ViewStyle>
  labelStyle?: StyleProp<TextStyle>
  /** 0 lets a long label wrap inside the button. */
  numberOfLines?: number
  icon?: ReactNode
  iconOnly?: boolean
  spinnerColor: string
  /** A control whose unavailable state is part of its design (an empty composer's Send). */
  disabledStyle?: StyleProp<ViewStyle>
  hitSlop?: number | Insets
  accessibilityLabel?: string
  accessibilityHint?: string
  testID?: string
  /** A list row's content (a choice's label and description) in place of the icon and label; it stays readable while the row's send is out. */
  children?: ReactNode
  contentStyle?: StyleProp<ViewStyle>
}): React.JSX.Element {
  const off = disabled || (pending && !pressWhilePending)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: off, busy: pending }}
      // react-native-web maps aria-busy but not accessibilityState.busy.
      aria-busy={pending}
      disabled={off}
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={hitSlop}
      testID={testID}
      style={({ pressed }) => [
        style,
        pressed && styles.pressed,
        disabled && !pending && (disabledStyle ?? styles.disabled)
      ]}
    >
      {children ? (
        <>
          <View style={contentStyle}>{children}</View>
          {pending ? <ActivityIndicator size="small" color={spinnerColor} /> : null}
        </>
      ) : (
        <>
          {/* The content keeps the button's size while it spins. */}
          {icon ? <View style={pending && styles.hidden}>{icon}</View> : null}
          {iconOnly ? null : (
            <Text style={[labelStyle, pending && styles.hidden]} numberOfLines={numberOfLines}>
              {label}
            </Text>
          )}
          {pending ? (
            <ActivityIndicator size="small" color={spinnerColor} style={styles.spinner} />
          ) : null}
        </>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  pressed: { opacity: feedback.pressedOpacity },
  disabled: { opacity: feedback.disabledOpacity },
  hidden: { opacity: 0 },
  spinner: StyleSheet.absoluteFill
})
