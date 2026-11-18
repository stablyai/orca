// The phone's composer under-row Slack item ("#eng thread"); a press opens the chat's Slack sheet.
import { Pressable, Text, View } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { MobileConnectorSourceIcon } from '../../../bots/MobileConnectorSourceIcon'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { slackMirrorView } from '../../../../../src/shared/connectors/slack-mirror-state'
import { useMobileSlackMirrorContext } from './use-mobile-slack-mirror'
import { useMobileSlackMirrorCopy } from './mobile-slack-mirror-copy'

export function MobileSlackMirrorItem(): React.JSX.Element | null {
  useMobileColorScheme()
  const mirror = useMobileSlackMirrorContext()
  const say = useMobileSlackMirrorCopy()
  if (!mirror) {
    return null
  }
  const view = slackMirrorView(mirror.link, mirror.botName)
  return (
    <Pressable
      onPress={mirror.openSheet}
      accessibilityRole="button"
      accessibilityLabel={say(view.label)}
      style={({ pressed }) => [styles.item, pressed && styles.pressed]}
      testID="native-chat-slack-mirror-item"
    >
      <View style={view.on ? undefined : styles.off}>
        <MobileConnectorSourceIcon source="slack" size={12} />
      </View>
      <Text style={styles.label} numberOfLines={1}>
        {view.on ? say(view.short) : say(view.label)}
      </Text>
      <ChevronDown size={12} color={colors.textMuted} />
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs
  },
  pressed: { opacity: 0.7 },
  off: { opacity: 0.6 },
  label: {
    flexShrink: 1,
    fontSize: typography.metaSize,
    color: colors.textSecondary
  }
}))
