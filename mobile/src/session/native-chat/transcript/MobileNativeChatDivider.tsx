import { StyleSheet, Text, View } from 'react-native'
import { spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../theme/themed-styles'

/** A quiet line across the transcript with a label in the middle. */
export function MobileNativeChatDivider({ label }: { label: string }): React.JSX.Element {
  const mobileNativeChatDividerStyles = useThemedStyles(mobileNativeChatDividerStylesSheet)
  return (
    <View
      style={mobileNativeChatDividerStyles.divider}
      accessibilityRole="text"
      accessibilityLabel={label}
    >
      <View style={mobileNativeChatDividerStyles.rule} />
      <Text style={mobileNativeChatDividerStyles.dividerLabel}>{label}</Text>
      <View style={mobileNativeChatDividerStyles.rule} />
    </View>
  )
}

export const mobileNativeChatDividerStylesSheet = themedStyleSheet((colors) => ({
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
    fontSize: typography.metaSize
  }
}))
