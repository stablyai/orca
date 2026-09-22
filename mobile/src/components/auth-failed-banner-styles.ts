import { StyleSheet } from 'react-native'
import { colors, spacing } from '../theme/mobile-theme'

/** Shared with `AuthFailedBannerActions`, which is a sibling file so that the page can drop it. */
export const authFailedBannerStyles = StyleSheet.create({
  banner: {
    backgroundColor: colors.bgPanel,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  text: {
    color: colors.statusRed,
    fontSize: 13,
    marginBottom: spacing.sm
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.lg
  },
  action: {
    paddingVertical: spacing.xs
  },
  actionText: {
    color: colors.accentBlue,
    fontSize: 13,
    fontWeight: '600'
  }
})
