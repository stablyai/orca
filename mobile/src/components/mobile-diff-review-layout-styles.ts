import { StyleSheet } from 'react-native'
import { colors, spacing, textStyles, typography } from '../theme/mobile-theme'

// The review screen's frame: bar, filters, file summary and the diff list.
export const mobileDiffReviewLayoutStyles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  contentRow: { flex: 1, flexDirection: 'row' },
  diffColumn: { flex: 1, minWidth: 0 },
  filterRow: {
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
    alignItems: 'center'
  },
  fileHeader: {
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
    paddingBottom: spacing.sm,
    gap: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator
  },
  fileTitleRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  statusLetter: {
    ...textStyles.subhead,
    fontFamily: typography.monoFamily,
    fontWeight: '600',
    width: 16,
    textAlign: 'center',
    flexShrink: 0
  },
  fileTitleBlock: { flex: 1, minWidth: 0 },
  filePath: { ...textStyles.subhead, color: colors.textSecondary },
  fileDirectory: { ...textStyles.footnote, color: colors.textMuted },
  fileMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    paddingRight: spacing.md
  },
  position: {
    ...textStyles.caption,
    color: colors.textMuted,
    fontVariant: ['tabular-nums'],
    marginLeft: 'auto'
  },
  fileNotes: { gap: spacing.xs, paddingRight: spacing.md },
  diffList: { paddingBottom: spacing.lg },
  diffHint: {
    ...textStyles.caption,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  truncatedText: {
    ...textStyles.footnote,
    color: colors.textMuted,
    padding: spacing.lg,
    textAlign: 'center'
  },
  actionError: { marginTop: spacing.sm }
})
