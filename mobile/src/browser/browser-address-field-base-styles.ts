import { colors, radii, spacing, typography } from '../theme/mobile-theme'

/**
 * The address bar's input and its overlaid label, minus the one thing that is a platform answer.
 *
 * Shared because a `.web.ts` cannot import a value from the file it shadows, and two copies of a
 * style object is how the two platforms drift apart on everything except the difference that was
 * meant to be between them.
 */
export const browserAddressFieldBase = {
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
} as const
