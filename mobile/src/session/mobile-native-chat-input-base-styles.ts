import { colors, radii, spacing } from '../theme/mobile-theme'

/**
 * The chat's two free-text fields, minus the one thing that is a platform answer.
 *
 * The composer spans its row and grows to 140; the question's field shares the row with a send
 * button and stops at 120. Everything else about them is the same and is here, because a `.web.ts`
 * cannot import a value from the file it shadows and two copies of a style object drift apart on
 * everything except the difference that was meant to be between them.
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
  input: { ...chatInputSurface, width: '100%', maxHeight: 140 },
  freeInput: { ...chatInputSurface, flex: 1, maxHeight: 120 }
} as const
