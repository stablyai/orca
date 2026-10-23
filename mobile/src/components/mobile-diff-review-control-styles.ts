import { StyleSheet } from 'react-native'
import { colors, MIN_TOUCH_TARGET, radii, spacing, textStyles } from '../theme/mobile-theme'

// The review screen's controls: file notes, footer toolbar and sheet bodies.
export const mobileDiffReviewControlStyles = StyleSheet.create({
  fileNote: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.field,
    backgroundColor: colors.fill
  },
  fileNotePressed: { backgroundColor: colors.fillPressed },
  fileNoteText: { ...textStyles.subhead, flex: 1, minWidth: 0, color: colors.textSecondary },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
    backgroundColor: colors.bgBase,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator
  },
  footerSpacer: { flex: 1 },
  sheetBody: { gap: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.lg },
  sheetActions: { gap: spacing.sm, paddingTop: spacing.sm, paddingBottom: spacing.lg },
  composerActions: { flexDirection: 'row', justifyContent: 'flex-end' }
})
