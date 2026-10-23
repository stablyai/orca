import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronUp } from 'lucide-react-native'
import { colors, MIN_TOUCH_TARGET, spacing, textStyles } from '../theme/mobile-theme'
import { pressTransition } from '../components/ui/transition-styles'
import { COMPOSER_TRAY_TUCK, composerTrayStyles } from './mobile-native-chat-composer-styles'

/** A collapsed prompt above the usable composer: the whole tab expands it and gives it Send again. */
export function MobileNativeChatPromptStrip({
  title,
  onExpand
}: {
  title: string
  onExpand: () => void
}): React.JSX.Element {
  return (
    <View testID="native-chat-prompt-strip" style={composerTrayStyles.layer}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Expand"
        accessibilityHint={title}
        accessibilityState={{ expanded: false }}
        onPress={onExpand}
      >
        {({ pressed }) => (
          <View
            style={[
              composerTrayStyles.panel,
              styles.strip,
              pressed && styles.pressed,
              pressed ? pressTransition.pressed : pressTransition.rest
            ]}
          >
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <ChevronUp size={18} color={colors.textSecondary} strokeWidth={2.2} />
          </View>
        )}
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  strip: {
    minHeight: MIN_TOUCH_TARGET + COMPOSER_TRAY_TUCK,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  pressed: { backgroundColor: colors.bgRaised },
  title: { ...textStyles.callout, fontWeight: '500', flex: 1, color: colors.textPrimary }
})
