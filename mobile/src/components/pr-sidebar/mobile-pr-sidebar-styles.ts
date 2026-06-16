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
  },
  // ─── Actions (U6) ─────────────────────────────────────────────────────────
  // Merge-method selector: three segmented buttons; the chosen one highlights.
  methodRow: {
    flexDirection: 'row',
    gap: spacing.xs
  },
  methodButton: {
    flex: 1,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xs,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  methodButtonSelected: {
    borderColor: colors.accentBlue,
    backgroundColor: colors.bgRaised
  },
  methodButtonText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  methodButtonTextSelected: {
    color: colors.textPrimary
  },
  // Primary CTA (merge) and secondary action buttons (close/reopen/rerun/add).
  actionButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  actionButtonPrimary: {
    backgroundColor: colors.accentBlue,
    borderColor: colors.accentBlue
  },
  actionButtonDisabled: {
    opacity: 0.5
  },
  actionButtonText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  actionButtonTextPrimary: {
    color: '#fff'
  },
  actionButtonDestructiveText: {
    color: colors.statusRed
  },
  // Auto-merge toggle row: label + a pill that reflects on/off state.
  toggleRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  toggleLabel: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    flexShrink: 1
  },
  togglePill: {
    minWidth: 56,
    minHeight: 30,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  togglePillOn: {
    borderColor: colors.statusGreen,
    backgroundColor: colors.bgRaised
  },
  togglePillText: {
    fontSize: typography.metaSize,
    fontWeight: '700',
    color: colors.textSecondary
  },
  togglePillTextOn: {
    color: colors.statusGreen
  },
  // Non-blocking error line shown under an action after a transient failure.
  actionError: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    lineHeight: 18
  },
  // Trailing control area in a reviewer row (add/remove button or spinner).
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
    borderRadius: radii.button
  },
  // ─── Reviewer picker (BottomDrawer) ───────────────────────────────────────
  pickerTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: spacing.sm
  },
  pickerSearch: {
    minHeight: 40,
    borderRadius: radii.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    fontSize: typography.bodySize,
    marginBottom: spacing.sm
  },
  pickerList: {
    maxHeight: 320
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
})
