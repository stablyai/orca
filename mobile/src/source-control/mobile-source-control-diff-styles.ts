import { StyleSheet } from 'react-native'
import { colors, spacing, textStyles } from '../theme/mobile-theme'

// The committed-diff preview sheet.
export const diffStyles = StyleSheet.create({
  diffState: {
    minHeight: 220
  },
  diffLines: {
    marginHorizontal: -spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.lg
  },
  diffTruncatedText: {
    ...textStyles.footnote,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md
  }
})
