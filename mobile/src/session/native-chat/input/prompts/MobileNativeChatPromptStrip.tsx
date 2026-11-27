import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronUp } from 'lucide-react-native'
import { spacing, typography, pressedStyle } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'

export type MobileNativeChatCollapsedPrompt = {
  title: string
  expand: () => void
  /** The agent waits on this answer alone, so collapsing it gives no composer back. */
  holdsInput?: true
}

/** A collapsed prompt's one line, above the queue; nothing while no prompt is collapsed. */
export function MobileNativeChatPromptStrip({
  prompt
}: {
  prompt?: MobileNativeChatCollapsedPrompt | null
}): React.JSX.Element | null {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  if (!prompt) {
    return null
  }
  return (
    <View testID="native-chat-prompt-strip" style={styles.strip}>
      <Text style={styles.title} numberOfLines={1}>
        {prompt.title}
      </Text>
      <Pressable
        accessibilityLabel={t('chat.promptStrip.expand', 'Expand')}
        accessibilityState={{ expanded: false }}
        hitSlop={8}
        style={({ pressed }) => [styles.action, pressed && pressedStyle]}
        onPress={prompt.expand}
      >
        <ChevronUp size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  action: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.chatPanel,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  title: { flex: 1, color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' }
}))
