import { Pressable, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { INLINE_TEXT_SELECTION } from '../../../components/inline-text-selection'
import { colors, spacing, typography, pressedStyle } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { scaledType } from './mobile-native-chat-message-styles'
import { toolStyles } from './mobile-native-chat-tool-styles'

export function MobileNativeChatNoticeDisclosureSummary({
  summary,
  expanded,
  fontScale,
  onPress,
  onLongPress
}: {
  summary: string
  expanded: boolean
  fontScale: number
  onPress: () => void
  onLongPress?: () => void
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={summary}
      aria-expanded={expanded}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.disclosure, pressed && pressedStyle]}
    >
      <View style={expanded ? toolStyles.caretOpen : undefined}>
        <ChevronRight size={16 * fontScale} color={colors.textMuted} />
      </View>
      <Text
        selectable={INLINE_TEXT_SELECTION}
        numberOfLines={1}
        style={[styles.faint, scaledType(typography.bodySize, fontScale), styles.summary]}
      >
        {summary}
      </Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm
  },
  summary: {
    flex: 1
  },
  faint: {
    color: colors.textMuted
  }
}))
