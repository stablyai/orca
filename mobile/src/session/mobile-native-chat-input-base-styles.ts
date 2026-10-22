import { colors, radii, spacing } from '../theme/mobile-theme'

/**
 * The chat's two free-text fields, minus the one thing that is a platform answer.
 *
 * The composer's field sits flush inside its box, which carries the surface, and grows to about
 * seven lines; the question's field shares the row with a send button and stops at 120. They live
 * here because a `.web.ts` cannot import a value from the file it shadows.
 */
const chatInputSurface = {
  minHeight: 40,
  color: colors.textPrimary,
  backgroundColor: colors.bgRaised,
  borderRadius: radii.input,
  paddingHorizontal: spacing.md,
  paddingTop: spacing.sm,
  paddingBottom: spacing.sm
} as const

export const mobileNativeChatInputBase = {
  input: {
    width: '100%',
    minHeight: 30,
    maxHeight: 154,
    lineHeight: 22,
    color: colors.textPrimary,
    paddingHorizontal: 6,
    paddingTop: 2,
    paddingBottom: 2
  },
  freeInput: { ...chatInputSurface, flex: 1, maxHeight: 120 }
} as const
