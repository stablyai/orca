import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'

export const mobilePrComposeFormStyles = StyleSheet.create({
  root: {
    gap: spacing.sm
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.xs
  },
  headingTitle: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  heading: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  headingActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  genButton: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  genButtonPressed: {
    opacity: 0.7
  },
  genButtonText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  iconButton: {
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  branchFlow: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  branchToken: {
    maxWidth: 116,
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  },
  branchTokenError: {
    color: colors.statusRed
  },
  fieldStack: {
    gap: spacing.sm
  },
  titleInput: {
    minHeight: 40,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  bodyInput: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    // Why: a moderate fixed height avoids over-expanding inside the sidebar scroll.
    minHeight: 120,
    textAlignVertical: 'top'
  },
  baseRow: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  baseLabel: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    width: 36
  },
  baseControl: {
    flex: 1,
    minWidth: 0
  },
  draftRow: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.sm
  },
  draftText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs
  },
  noticeText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 18
  },
  errorText: {
    color: colors.statusRed
  },
  submit: {
    marginTop: spacing.xs,
    minHeight: 44,
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs
  },
  submitDisabled: {
    opacity: 0.45
  },
  submitPressed: {
    opacity: 0.8
  },
  submitText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '700'
  }
})
