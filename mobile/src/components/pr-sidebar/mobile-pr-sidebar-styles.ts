import { StyleSheet } from 'react-native'
import { colors, radii, spacing, textStyles, typography } from '../../theme/mobile-theme'

// Fixed inline-dock width (KTD2/U4): leaves the diff >= ~380px within the 700px
// breakpoint where docking engages.
export const PR_SIDEBAR_DOCK_WIDTH = 320

/** Horizontal inset of the PR tab's own text blocks, matching the inset groups' text edge. */
export const PR_PAGE_INSET = spacing.lg + 4

export const mobilePrSidebarStyles = StyleSheet.create({
  // The inline-docked column lives in the screen's flex row beside the diff.
  dockColumn: {
    width: PR_SIDEBAR_DOCK_WIDTH,
    backgroundColor: colors.bgBase,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.separator
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: spacing.xl
  },
  // A section: sentence-case header over an inset group.
  section: {
    paddingTop: spacing.xs
  },
  sectionFooter: {
    paddingHorizontal: PR_PAGE_INSET,
    paddingTop: spacing.sm
  },
  group: {
    marginHorizontal: spacing.lg,
    borderRadius: radii.group,
    backgroundColor: colors.groupFill,
    overflow: 'hidden'
  },
  groupPadded: {
    padding: spacing.lg,
    gap: spacing.md
  },
  bare: {
    marginHorizontal: spacing.lg,
    gap: spacing.md
  },
  // Identity: badge + number, title, head → base.
  identityBlock: {
    paddingHorizontal: PR_PAGE_INSET,
    paddingTop: spacing.lg,
    gap: spacing.sm
  },
  metaRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  metaLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  prMeta: {
    ...textStyles.subhead,
    color: colors.textSecondary,
    flexShrink: 1
  },
  prMetaStrong: {
    ...textStyles.subhead,
    fontWeight: '500',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums']
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs
  },
  prTitle: {
    ...textStyles.title,
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    paddingTop: spacing.sm
  },
  titleEdit: {
    gap: spacing.md
  },
  titleEditActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm
  },
  branchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6
  },
  branchPill: {
    flexShrink: 1,
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: typography.monoFamily,
    backgroundColor: colors.fill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radii.pill,
    overflow: 'hidden'
  },
  // A row inside an inset group that ListRow can't draw (coloured status, nested controls).
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  rowPressed: {
    backgroundColor: colors.fill
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  rowTitle: {
    ...textStyles.body,
    color: colors.textPrimary
  },
  rowTitleStrong: {
    fontWeight: '500'
  },
  // Checks rows are tighter on the right: the open-on-web button brings its own 44 pt box.
  checkRow: {
    paddingRight: spacing.xs,
    gap: spacing.sm + 2
  },
  chevronOpen: { transform: [{ rotate: '90deg' }] },
  chevronClosed: { transform: [{ rotate: '0deg' }] },
  rowSubtitle: {
    ...textStyles.subhead,
    color: colors.textSecondary
  },
  rowStatus: {
    ...textStyles.subhead,
    fontWeight: '500',
    flexShrink: 0
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  // Quiet text inside a group: empty, loading and failed rows.
  groupNote: {
    ...textStyles.callout,
    color: colors.textSecondary
  },
  rowSpinner: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  noteRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  noteRowText: {
    ...textStyles.callout,
    color: colors.textSecondary,
    flex: 1,
    minWidth: 0
  },
  actionError: {
    marginTop: spacing.sm
  },
  checkDetailArea: {
    paddingLeft: spacing.lg + 28,
    paddingRight: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.sm
  },
  checkDetailText: {
    ...textStyles.subhead,
    color: colors.textSecondary
  },
  checkDetailGroup: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    paddingTop: spacing.sm,
    gap: spacing.xs
  },
  checkDetailGroupLabel: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textMuted
  },
  checkDetailLocator: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: typography.monoFamily
  },
  checkDetailEmphasis: {
    ...textStyles.subhead,
    fontWeight: '500',
    color: colors.textPrimary,
    flexShrink: 1
  },
  checkDetailStepRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingLeft: spacing.sm
  },
  checkDetailLogScroll: {
    maxHeight: 180,
    marginTop: spacing.xs,
    backgroundColor: colors.fieldFill,
    borderRadius: radii.composerItem,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  checkDetailLogText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: typography.monoFamily
  },
  // ─── Reviewer picker (BottomDrawer) ───────────────────────────────────────
  pickerSearch: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.md
  },
  // No FlatList: the parent BottomDrawer scrolls this block so we never nest a
  // VirtualizedList inside the PR page ScrollView.
  pickerList: {
    marginHorizontal: 0,
    marginBottom: spacing.md
  },
  pickerState: {
    minHeight: 200
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.fillPressed,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  },
  avatarImage: {
    ...StyleSheet.absoluteFillObject
  },
  avatarInitial: {
    ...textStyles.footnote,
    fontWeight: '600',
    color: colors.textSecondary
  }
})
