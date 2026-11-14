import { Pressable, Text, type StyleProp, type ViewStyle } from 'react-native'
import type { Play } from 'lucide-react-native'
import { colors, pressedStyle, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { styles as chatStyles } from '../mobile-native-chat-view-styles'

// The chat's small secondary action, as its Try Again on earlier messages.
export function MobileNativeChatNoticePill({
  label,
  Icon,
  accessibilityHint,
  onPress,
  style
}: {
  label: string
  Icon: typeof Play
  accessibilityHint?: string
  onPress: () => void
  style?: StyleProp<ViewStyle>
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [chatStyles.retryPill, styles.pill, style, pressed && pressedStyle]}
    >
      <Icon size={14} color={colors.textSecondary} />
      <Text style={chatStyles.retryPillLabel}>{label}</Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  }
}))
