import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

export const prFilesStyles = themedStyleSheet(() => ({
  toolbar: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  progressText: {
    flexShrink: 1,
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgBase
  },
  chipActive: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  chipText: { fontSize: typography.metaSize, fontWeight: '600', color: colors.textSecondary },
  chipTextActive: { color: colors.bgPanel },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingRight: spacing.md
  },
  rowPressed: { backgroundColor: colors.bgRaised },
  fileRow: { gap: 0 },
  directoryName: {
    flex: 1,
    minWidth: 0,
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  folderViewed: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  folderCount: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  viewedHit: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control
  },
  viewedHitDisabled: { opacity: 0.4 },
  fileBody: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'stretch',
    borderRadius: radii.control
  },
  statusLetter: {
    width: 12,
    fontSize: typography.metaSize,
    fontWeight: '700',
    fontFamily: typography.monoFamily,
    textAlign: 'center'
  },
  fileText: { flex: 1, minWidth: 0 },
  fileName: { fontSize: typography.bodySize, color: colors.textPrimary },
  fileNameViewed: { color: colors.textSecondary },
  fileDirectory: { fontSize: 11, color: colors.textMuted },
  changedPill: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.statusAmber,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.statusAmber,
    borderRadius: radii.pill,
    overflow: 'hidden',
    paddingHorizontal: 6,
    paddingVertical: 1
  },
  threadBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  threadBadgeText: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  },
  lineCounts: { flexDirection: 'row', gap: 6, minWidth: 0 },
  additions: {
    fontSize: typography.metaSize,
    color: colors.statusGreen,
    fontVariant: ['tabular-nums']
  },
  deletions: {
    fontSize: typography.metaSize,
    color: colors.statusRed,
    fontVariant: ['tabular-nums']
  },
  stateArea: {
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl
  },
  stateText: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    textAlign: 'center'
  },
  errorText: {
    fontSize: typography.metaSize,
    color: colors.statusRed,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm
  }
}))
