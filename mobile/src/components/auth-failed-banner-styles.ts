import { StyleSheet } from 'react-native'
import { colors, radii, spacing, textStyles } from '../theme/mobile-theme'

/**
 * Shared with `AuthFailedBannerActions`, a sibling file so that the page can offer Re-pair alone.
 * Draws the shared `Banner`'s error tone, which takes one action; this one needs a row of them.
 */
export const authFailedBannerStyles = StyleSheet.create({
  frame: { paddingTop: spacing.sm, paddingBottom: spacing.xs },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.group,
    // Banner's error fill: `danger` at 10%.
    backgroundColor: 'rgba(255, 107, 107, 0.1)'
  },
  icon: { marginTop: 1 },
  main: { flex: 1, minWidth: 0, gap: 2 },
  title: { ...textStyles.callout, fontWeight: '600', color: colors.textPrimary },
  text: { ...textStyles.callout, color: colors.textSecondary },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: spacing.sm,
    marginTop: spacing.xs
  },
  // Muted so the page's pointer to the app does not read as a second control.
  note: {
    ...textStyles.footnote,
    flexBasis: '100%',
    color: colors.textMuted
  }
})
