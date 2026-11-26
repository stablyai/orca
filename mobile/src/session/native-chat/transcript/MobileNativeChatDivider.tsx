import { ArrowRightLeft } from 'lucide-react-native'
import { tuiAgentDisplayName } from '../../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'

/** A quiet line across the transcript with a label in the middle. */
export function MobileNativeChatDivider({
  label,
  failed,
  handoff
}: {
  label: string
  failed?: boolean
  handoff?: boolean
}): React.JSX.Element {
  useMobileColorScheme()
  return (
    <View
      style={mobileNativeChatDividerStyles.divider}
      accessibilityRole="text"
      accessibilityLabel={label}
    >
      <View style={mobileNativeChatDividerStyles.rule} />
      {handoff ? (
        <ArrowRightLeft size={12} color={failed ? colors.statusRed : colors.textMuted} />
      ) : null}
      <Text
        style={[mobileNativeChatDividerStyles.dividerLabel, failed && { color: colors.statusRed }]}
      >
        {label}
      </Text>
      <View style={mobileNativeChatDividerStyles.rule} />
    </View>
  )
}

export const mobileNativeChatDividerStyles = themedStyleSheet(() => ({
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm
  },
  rule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle
  },
  dividerLabel: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    flexShrink: 1
  }
}))

export function useMobileChatProviderCopy(
  agent: string | null | undefined,
  next: string | undefined
) {
  const t = useMobileTranslation()
  if (!next) {
    return {}
  }
  const to = tuiAgentDisplayName(next) ?? next
  return {
    placeholder: t('chat.providerSwitch.nextMessage', 'Message {{agent}}…', { agent: to }),
    pending: agent
      ? t('chat.providerSwitch.pending', 'Context handoff pending · {{from}} → {{to}}', {
          from: tuiAgentDisplayName(agent) ?? agent,
          to
        })
      : undefined
  }
}
