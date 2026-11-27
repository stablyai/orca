import { colors, feedback, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { LIST_ROW_PADDING } from '../components/list/ListGroup'

export const troubleshootScreenStyles = themedStyleSheet(() => ({
  scroll: {
    flex: 1
  },
  diagnosticButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.sheetGroup,
    borderRadius: radii.control,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg
  },
  diagnosticButtonPressed: {
    opacity: feedback.pressedOpacity
  },
  diagnosticButtonDisabled: {
    opacity: feedback.disabledOpacity
  },
  diagnosticButtonLabel: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  checkDetail: {
    fontSize: typography.metaSize,
    color: colors.textMuted
  },
  checkDetailFail: {
    color: colors.statusRed
  },
  group: {
    marginBottom: spacing.lg
  },
  noteBody: {
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: spacing.md,
    gap: spacing.xs
  },
  stepText: {
    flex: 1,
    fontSize: typography.metaSize,
    color: colors.textMuted,
    lineHeight: 18
  }
}))
