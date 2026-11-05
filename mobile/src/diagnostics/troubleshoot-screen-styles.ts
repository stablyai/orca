import { colors, feedback, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { LIST_LEADING_INSET, LIST_ROW_PADDING } from '../components/list/ListGroup'

export const troubleshootScreenStyles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    padding: spacing.lg
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary
  },
  scroll: {
    flex: 1
  },
  scrollContent: {
    paddingBottom: spacing.xl
  },
  diagnosticButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgRaised,
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
  // On a screen, not a sheet: one step above the page, as the other screen groups are.
  group: {
    backgroundColor: colors.bgPanel,
    marginBottom: spacing.lg
  },
  // Steps start under the issue title, past its icon.
  accordionBody: {
    paddingLeft: LIST_LEADING_INSET,
    paddingRight: LIST_ROW_PADDING,
    paddingBottom: spacing.md,
    gap: spacing.xs
  },
  noteBody: {
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: spacing.md,
    gap: spacing.xs
  },
  stepRow: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  bullet: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    lineHeight: 18
  },
  stepText: {
    flex: 1,
    fontSize: typography.metaSize,
    color: colors.textMuted,
    lineHeight: 18
  }
}))
