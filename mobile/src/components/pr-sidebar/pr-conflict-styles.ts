import { StyleSheet } from 'react-native'
import { colors, radii, spacing, textStyles, typography } from '../../theme/mobile-theme'

// The conflicts section: notice, conflicting files and the mergeability refresh commands.
export const prConflictStyles = StyleSheet.create({
  notice: {
    gap: spacing.xs
  },
  noticeTitle: {
    ...textStyles.body,
    fontWeight: '500',
    color: colors.textPrimary,
    flexShrink: 1
  },
  noticeBody: {
    ...textStyles.callout,
    color: colors.textSecondary
  },
  meta: {
    ...textStyles.subhead,
    color: colors.textSecondary
  },
  metaMono: {
    fontFamily: typography.monoFamily,
    fontSize: 13,
    color: colors.textSecondary
  },
  filesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  // Capped and scrollable so a long conflict set doesn't push the rest of the page off-screen.
  fileList: {
    maxHeight: 264,
    marginHorizontal: -spacing.lg
  },
  fileListContent: {
    paddingHorizontal: spacing.lg
  },
  fileRow: {
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator
  },
  fileName: {
    ...textStyles.callout,
    color: colors.textPrimary
  },
  fileDir: {
    ...textStyles.footnote,
    color: colors.textMuted
  },
  commandBlock: {
    gap: spacing.xs
  },
  commandHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  commandLabel: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textMuted,
    flexShrink: 1
  },
  commandBox: {
    backgroundColor: colors.fieldFill,
    borderRadius: radii.composerItem,
    padding: spacing.md
  },
  commandText: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 13,
    lineHeight: 19
  }
})
