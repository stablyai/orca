import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

// Dock width leaves diff ~380px at 700px breakpoint (KTD2/U4).
export const PR_SIDEBAR_DOCK_WIDTH = 320

export const mobilePrSidebarStyles = themedStyleSheet(() => ({
  dockColumn: {
    width: PR_SIDEBAR_DOCK_WIDTH,
    backgroundColor: colors.bgPanel,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.borderSubtle
  },
  // Use full-bleed panel bands separated by hairlines; header keeps title/body divider.
  section: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  // Match desktop section header’s title/trailing control and hairline body divider.
  sectionHeader: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  sectionHeaderTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  sectionBody: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm
  },
  sectionLabel: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600'
  },
  checkDetailArea: {
    paddingLeft: spacing.lg,
    paddingBottom: spacing.xs,
    gap: spacing.xs
  },
  checkDetailText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 18
  },
  // Keep annotation/jobs detail muted below hairline summary divider.
  checkDetailGroup: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    paddingTop: spacing.sm,
    gap: spacing.xs
  },
  checkDetailGroupLabel: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  checkDetailLocator: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  },
  checkDetailEmphasis: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    lineHeight: 18,
    fontWeight: '600'
  },
  checkDetailStepRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingLeft: spacing.sm
  },
  // Scroll raised monospace host-log tail so long output cannot push sidebar off-screen.
  checkDetailLogScroll: {
    maxHeight: 160,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.surface,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  checkDetailLogText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily,
    lineHeight: 16
  }
}))
