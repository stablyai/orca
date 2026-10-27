import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyles } from '../theme/themed-styles'

// Keep common styles outside platform siblings: .web cannot import the file it shadows, and copies drift.
export const browserAddressFieldBase = themedStyles(
  () =>
    ({
      input: {
        flex: 1,
        minWidth: 0,
        borderRadius: radii.input,
        backgroundColor: colors.bgRaised,
        color: colors.textPrimary,
        paddingHorizontal: spacing.sm,
        paddingVertical: 0,
        includeFontPadding: false,
        textAlignVertical: 'center',
        fontFamily: typography.monoFamily
      },
      fileLabel: {
        color: colors.textPrimary,
        fontFamily: typography.monoFamily
      }
    }) as const
)
