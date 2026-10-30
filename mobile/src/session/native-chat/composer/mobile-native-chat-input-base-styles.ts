import { colors, radii, spacing } from '../../../theme/mobile-theme'
import { themedStyles } from '../../../theme/themed-styles'

// Keep platform-neutral styles separate because a web sibling cannot import the file it shadows.
export const mobileNativeChatInputBase = themedStyles(() => {
  const chatInputSurface = {
    minHeight: 40,
    color: colors.textPrimary,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm
  } as const
  return {
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
})
