import { StyleSheet } from 'react-native'
import { colors, spacing } from '../theme/mobile-theme'

/** Shared with `AuthFailedBannerActions`, a sibling file so that the page can offer Re-pair alone. */
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
  },
  // Muted so the page's pointer to the app does not read as a second control.
  note: {
    flexShrink: 1,
    paddingVertical: spacing.xs,
    color: colors.textSecondary,
    fontSize: 13
  }
})
