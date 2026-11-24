import { Pressable, Text, type StyleProp, type ViewStyle } from 'react-native'
import type { Play } from 'lucide-react-native'
import { colors, pressedStyle, spacing } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { styles as chatStyles } from '../../mobile-native-chat-view-styles'

// The chat's small secondary action, as its Try Again on earlier messages; `primary` fills it.
export function MobileNativeChatNoticePill({
  label,
  Icon,
  accessibilityHint,
  onPress,
  primary = false,
  disabled = false,
  style
}: {
  label: string
  Icon?: typeof Play
  accessibilityHint?: string
  onPress: () => void
  primary?: boolean
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      accessibilityState={disabled ? { disabled } : undefined}
      disabled={disabled}
      // 28 pt to see, 44 pt to touch.
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        chatStyles.retryPill,
        styles.pill,
        primary && styles.primary,
        disabled && styles.disabled,
        style,
        pressed && pressedStyle
      ]}
    >
      {Icon ? <Icon size={14} color={primary ? colors.bgBase : colors.textSecondary} /> : null}
      <Text style={[chatStyles.retryPillLabel, primary && styles.primaryLabel]}>{label}</Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  primary: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  primaryLabel: { color: colors.bgBase },
  disabled: { opacity: 0.4 }
}))
