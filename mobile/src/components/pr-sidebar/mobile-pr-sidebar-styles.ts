import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'

// Fixed inline-dock width (KTD2/U4): leaves the diff >= ~380px within the 700px
// breakpoint where docking engages.
export const PR_SIDEBAR_DOCK_WIDTH = 320

export const mobilePrSidebarStyles = StyleSheet.create({
  // The inline-docked column lives in the screen's flex row beside the diff.
  dockColumn: {
    width: PR_SIDEBAR_DOCK_WIDTH,
    backgroundColor: colors.bgPanel,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.borderSubtle
  },
  // Inner scroll area; the diff and the sidebar scroll independently.
  scrollContent: {
    padding: spacing.lg,
    gap: spacing.md
  },
  section: {
    padding: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    gap: spacing.xs
  },
  sectionLabel: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  // Header section: state badge, title, author, base<-head branches.
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth
  },
  badgeText: {
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  prTitle: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '700',
    lineHeight: 24
  },
  prMeta: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  branchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs
  },
  branchPill: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radii.button
  },
  // Generic list row, mirroring the diff-review row rhythm (44dp min target).
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
    borderRadius: 4
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  summaryRow: {
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
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  retryText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  }
})
