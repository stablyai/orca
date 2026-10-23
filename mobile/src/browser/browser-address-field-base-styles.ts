import { fontFamilies } from '../theme/font-families'
import { colors } from '../theme/mobile-theme'

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
    color: colors.textPrimary,
    paddingHorizontal: 14,
    paddingVertical: 0,
    includeFontPadding: false,
    textAlignVertical: 'center',
    ...fontFamilies.sans
  },
  fileLabel: {
    color: colors.textPrimary,
    ...fontFamilies.sans
  }
} as const
