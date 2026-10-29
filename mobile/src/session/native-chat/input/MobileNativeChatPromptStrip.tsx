import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronUp } from 'lucide-react-native'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'

export function MobileNativeChatPromptStrip({
  title,
  onExpand
}: {
  title: string
  onExpand: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View testID="native-chat-prompt-strip" style={styles.strip}>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <Pressable
        accessibilityLabel={t('chat.promptStrip.expand', 'Expand')}
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

const styles = themedStyleSheet(() => ({
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
}))
