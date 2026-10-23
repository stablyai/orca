import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native'
import { pressTransition } from '../components/ui/transition-styles'
import { colors, MIN_TOUCH_TARGET, radii, spacing, textStyles } from '../theme/mobile-theme'

/** A quiet text button inside a message ("Show full message", "Show all"): 44 pt tall, a soft
 *  capsule fill while pressed, its label in the footnote step. */
export function MobileNativeChatTextAction({
  label,
  onPress,
  disabled = false,
  expanded,
  align = 'start',
  style
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  expanded?: boolean
  align?: 'start' | 'end'
  style?: StyleProp<ViewStyle>
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={expanded === undefined ? { disabled } : { disabled, expanded }}
      style={({ pressed }) => [
        styles.action,
        align === 'end' ? styles.end : styles.start,
        pressed && styles.pressed,
        pressed ? pressTransition.pressed : pressTransition.rest,
        style
      ]}
    >
      <Text style={[styles.label, disabled && styles.disabled]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  action: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill
  },
  start: { alignSelf: 'flex-start', marginLeft: -spacing.sm },
  end: { alignSelf: 'flex-end', marginRight: -spacing.sm },
  pressed: { backgroundColor: colors.fill },
  label: { ...textStyles.footnote, fontWeight: '500', color: colors.textSecondary },
  disabled: { color: colors.textMuted }
})
