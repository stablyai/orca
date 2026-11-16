import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const voiceSettingsStyles = themedStyleSheet(() => ({
  drawerTitle: {
    fontSize: typography.bodySize,
    fontWeight: '700',
    color: colors.textPrimary,
    paddingHorizontal: spacing.md + 2,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs
  }
}))
