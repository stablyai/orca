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
  // Inner scroll area; the diff and the sidebar scroll independently. Flat layout
  // (desktop ChecksPanel): sections butt against each other with border-b
  // dividers, so no outer padding or inter-section gap.
  scrollContent: {
    paddingBottom: spacing.lg
  },
  // Flat section band (desktop ChecksPanel sidebar): a full-bleed bgPanel block
  // divided from the next by a bottom hairline, rather than a stacked rounded
  // card. The header row keeps its own border-b for the title/body divide.
  section: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  // Section header row: title + optional trailing control, divided from the body
  // by a hairline border (desktop `h-10 border-b px-3`).
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
  // Identity + actions share one section card (hub redesign): no per-block chrome.
  identityBlock: {
    gap: spacing.sm
  },
  // State badge + #number + author on one row; open-on-web flush right when shown.
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
    borderRadius: radii.button,
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
  // #number in the meta row — stronger than author so the identity scans first.
  prMetaStrong: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  // Title row: tappable area pairing the title with a trailing edit affordance.
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
  // Loading / empty status row inside Reviewers (and similar) section bodies.
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
  // Annotations / jobs sub-section, divided from the summary by a hairline border
  // (desktop `border-t pt-2`). Muted/monochrome so the detail stays subdued.
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
  // Step rows are indented under their job to read as children.
  checkDetailStepRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingLeft: spacing.sm
  },
  // Log tail is preformatted host output; mono + a raised surface, vertically
  // scrollable so a long tail doesn't push the rest of the sidebar off-screen.
  checkDetailLogScroll: {
    maxHeight: 160,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.button,
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
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  retryText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
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
  // No maxHeight / FlatList: the parent BottomDrawer scrolls this block so we
  // never nest a VirtualizedList inside the PR page ScrollView.
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
})
