import { colors, typography } from '../theme/mobile-theme'

/**
 * The custom-key capture field, minus the one thing that is a platform answer.
 *
 * Shared because a `.web.ts` cannot import a value from the file it shadows, and two copies of a
 * style object is how the two platforms drift apart on everything except the difference that was
 * meant to be between them.
 */
export const customKeyInputBase = {
  width: '100%',
  height: 56,
  borderRadius: 10,
  backgroundColor: colors.bgPanel,
  borderWidth: 1,
  borderColor: colors.borderSubtle,
  color: colors.textPrimary,
  fontFamily: typography.monoFamily,
  fontWeight: '600',
  textAlign: 'center'
} as const
