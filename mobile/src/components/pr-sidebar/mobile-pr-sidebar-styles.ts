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
  // Diff/sidebar scroll independently; flat desktop-style sections use bottom dividers without outer padding/gaps.
  scrollContent: {
    paddingBottom: spacing.lg
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
    paddingHorizontal: spacing.md,
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
    padding: spacing.md,
    gap: spacing.sm
  },
  sectionLabel: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600'
  },
  identityBlock: {
    gap: spacing.sm
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  metaLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.bgRaised
  },
  badgeText: {
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  prTitle: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '700',
    lineHeight: 24
  },
  prMeta: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  prMetaStrong: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs
  },
  titleEditButton: {
    minWidth: 28,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center'
  },
  branchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs
  },
  branchPill: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radii.pill
  },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  rowTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  rowSubtitle: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  rowStatus: {
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: radii.pill
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  reviewersStatus: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  summaryLabel: {
    fontSize: typography.bodySize,
    fontWeight: '700'
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
  },
  stateArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md
  },
  stateText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    textAlign: 'center',
    lineHeight: 20
  },
  // Blocked state is a permanent failure (R9) — explanatory, not retry-encouraged.
  blockedText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    textAlign: 'center',
    lineHeight: 20
  },
  retryButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  retryText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  rowTrailing: {
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center'
  },
  iconButton: {
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control
  },
  pickerTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: spacing.sm
  },
  pickerSearch: {
    marginBottom: spacing.sm
  },
  // Let parent drawer scroll mapped rows; never nest VirtualizedList inside PR ScrollView.
  pickerList: {
    gap: 0
  },
  pickerRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs
  },
  pickerRowMain: {
    flex: 1,
    minWidth: 0
  },
  pickerStateArea: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm
  }
}))
