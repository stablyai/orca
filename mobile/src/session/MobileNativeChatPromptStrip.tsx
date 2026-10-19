import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronUp } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

/** A collapsed prompt above the usable composer; expanding gives it Send again. */
export function MobileNativeChatPromptStrip({
  title,
  onExpand
}: {
  title: string
  onExpand: () => void
}): React.JSX.Element {
  return (
    <View testID="native-chat-prompt-strip" style={styles.strip}>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <Pressable
        accessibilityLabel="Expand"
        accessibilityState={{ expanded: false }}
        hitSlop={8}
        style={styles.action}
        onPress={onExpand}
      >
        <ChevronUp size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  action: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.bgPanel,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  title: { flex: 1, color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' }
})
