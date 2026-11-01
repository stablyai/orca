import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { TEXT_INPUT_FONT_SIZE } from '../../platform/text-input-font-size'

export const prTabStyles = themedStyleSheet(() => ({
  container: { flex: 1, backgroundColor: colors.bgBase },
  dockBar: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: spacing.sm },
  scroll: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.md },
  stateArea: { flex: 1, padding: spacing.lg, justifyContent: 'center' },
  blockedText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    textAlign: 'center'
  },
  header: { gap: spacing.xs },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth
  },
  badgeText: { fontSize: typography.metaSize, fontWeight: '600' },
  number: { color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
  meta: { color: colors.textSecondary, fontSize: typography.metaSize, flexShrink: 1 },
  title: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '600',
    lineHeight: 24
  },
  refsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' },
  ref: {
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.mark,
    paddingHorizontal: spacing.xs,
    overflow: 'hidden',
    flexShrink: 1
  },
  changesCard: {
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: 6
  },
  changesTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  changesTitle: { flex: 1, color: colors.textPrimary, fontSize: 15, fontWeight: '500' },
  additions: {
    color: colors.gitDecorationAdded,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  deletions: {
    color: colors.gitDecorationDeleted,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  progressTrack: {
    height: 3,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill,
    overflow: 'hidden'
  },
  progressFill: { height: 3, borderRadius: radii.pill, backgroundColor: colors.accentBlue },
  changesMeta: { color: colors.textSecondary, fontSize: typography.metaSize },
  descriptionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.xs
  },
  sectionLabel: { fontSize: 13, fontWeight: '500', color: colors.textSecondary },
  textAction: { color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
  descriptionMuted: { color: colors.textMuted, fontSize: typography.bodySize },
  showMore: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600',
    paddingTop: spacing.xs
  },
  errorText: { color: colors.statusRed, fontSize: typography.metaSize },
  empty: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.xl * 2,
    paddingBottom: spacing.xl,
    paddingHorizontal: spacing.xl
  },
  emptyTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  emptyBody: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    textAlign: 'center',
    lineHeight: 20
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    gap: spacing.sm,
    backgroundColor: colors.bgBase
  },
  reason: { color: colors.textSecondary, fontSize: 13, textAlign: 'center' },
  reasonStrong: { color: colors.textPrimary, fontWeight: '600' },
  actionRow: { flexDirection: 'row', gap: spacing.sm },
  actionButton: {
    height: 48,
    borderRadius: radii.control,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  actionPrimary: { backgroundColor: colors.textPrimary },
  actionMerge: { backgroundColor: colors.mergeGreen },
  actionSecondary: { backgroundColor: colors.bgRaised },
  actionGrow: { flex: 1 },
  actionLabel: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  actionLabelPrimary: { color: colors.bgBase },
  actionLabelMerge: { color: colors.onMergeGreen },
  mergedNote: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm
  }
}))

export const prSheetStyles = themedStyleSheet(() => ({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.md },
  note: { color: colors.textSecondary, fontSize: 13 },
  error: { color: colors.statusRed, fontSize: 13 },
  state: { color: colors.textSecondary, fontSize: typography.metaSize },
  approved: { color: colors.statusGreen },
  field: {
    fontSize: TEXT_INPUT_FONT_SIZE,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md
  },
  multiline: { minHeight: 160, maxHeight: 320, textAlignVertical: 'top' }
}))
