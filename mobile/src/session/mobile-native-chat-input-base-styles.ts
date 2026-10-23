import { colors, textStyles } from '../theme/mobile-theme'

/**
 * The composer's field, minus its font size, which is a platform answer. It sits flush inside the
 * box, which carries the surface, and grows to seven lines before it scrolls. It lives here because
 * a `.web.ts` cannot import a value from the file it shadows.
 */
export const mobileNativeChatInputBase = {
  input: {
    ...textStyles.body,
    width: '100%',
    minHeight: textStyles.body.lineHeight + 4,
    maxHeight: textStyles.body.lineHeight * 7 + 4,
    color: colors.textPrimary,
    paddingHorizontal: 6,
    paddingTop: 2,
    paddingBottom: 2
  }
} as const
