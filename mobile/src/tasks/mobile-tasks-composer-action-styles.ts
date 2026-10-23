import {
  StyleSheet,
  Platform,
  colors,
  radii,
  spacing,
  textStyles,
  TEXT_INPUT_FONT_SIZE
} from './mobile-tasks-dependencies'

export const mobileTasksComposerActionStyles = StyleSheet.create({
  createForm: {
    gap: spacing.sm
  },
  fieldLabel: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textSecondary,
    paddingLeft: 4
  },
  inlineTextLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    minHeight: 44
  },
  inlineTextLinkText: {
    ...textStyles.footnote,
    color: colors.textSecondary,
    textDecorationLine: 'underline'
  },
  securityHintRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm
  },
  securityHintText: {
    ...textStyles.footnote,
    flex: 1,
    color: colors.textMuted
  },
  targetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    backgroundColor: colors.fieldFill,
    borderRadius: radii.field,
    paddingHorizontal: 14
  },
  targetButtonText: {
    ...textStyles.body,
    flex: 1,
    color: colors.textPrimary
  },
  issueSourceBox: {
    gap: spacing.sm
  },
  issueSourceHint: {
    ...textStyles.footnote,
    color: colors.textSecondary,
    paddingLeft: 4
  },
  issueSourceSegment: {
    flexDirection: 'row',
    borderRadius: radii.pill,
    backgroundColor: colors.fill,
    padding: 3,
    gap: 2
  },
  issueSourceSegmentButton: {
    flex: 1,
    minHeight: 38,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm
  },
  issueSourceSegmentButtonActive: {
    backgroundColor: colors.fillPressed
  },
  issueSourceSegmentText: {
    ...textStyles.subhead,
    fontWeight: '500',
    color: colors.textSecondary
  },
  issueSourceSegmentTextActive: {
    color: colors.textPrimary
  },
  issueSourceSlug: {
    ...textStyles.caption,
    color: colors.textMuted
  },
  drawerLoadingRow: {
    minHeight: 88,
    alignItems: 'center',
    justifyContent: 'center'
  },
  // Every Tasks field: 16 pt so the page's WebView never zooms on focus.
  input: {
    ...textStyles.body,
    fontSize: TEXT_INPUT_FONT_SIZE,
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    backgroundColor: colors.fieldFill,
    borderRadius: radii.field,
    paddingHorizontal: 14,
    paddingVertical: spacing.md,
    color: colors.textPrimary
  },
  bodyInput: {
    minHeight: 120
  },
  monoInput: {
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace'
    })
  },
  commentInput: {
    minHeight: 72,
    marginTop: spacing.sm
  },
  commentComposer: {
    marginTop: spacing.xs
  },
  commentComposerInput: {
    minHeight: 48,
    maxHeight: 160,
    marginTop: 0
  },
  replyInput: {
    minHeight: 48,
    marginTop: spacing.xs
  },
  stackedInput: {
    marginTop: spacing.sm
  },
  inlineSaveButton: {
    alignSelf: 'flex-start',
    justifyContent: 'center',
    minHeight: 36,
    marginTop: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.fill,
    paddingHorizontal: spacing.lg
  },
  inlineSaveButtonCompact: {
    alignSelf: 'flex-start',
    justifyContent: 'center',
    minHeight: 36,
    borderRadius: radii.pill,
    backgroundColor: colors.fill,
    paddingHorizontal: 14
  },
  inlineSaveText: {
    ...textStyles.subhead,
    fontWeight: '500',
    color: colors.textPrimary
  },
  inlineButtonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs
  },
  drawerActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  secondaryActionButton: {
    flex: 1,
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
    backgroundColor: colors.fill
  },
  secondaryActionText: {
    ...textStyles.body,
    fontWeight: '600',
    color: colors.textPrimary
  },
  primaryActionButton: {
    flex: 1,
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.primary
  },
  primaryActionText: {
    ...textStyles.body,
    fontWeight: '600',
    color: colors.onPrimary
  },
  inlineDeleteText: {
    ...textStyles.subhead,
    fontWeight: '500',
    color: colors.danger
  },
  createButton: {
    minHeight: 50,
    marginTop: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  createButtonDisabled: {
    opacity: 0.4
  },
  createButtonText: {
    ...textStyles.body,
    fontWeight: '600',
    color: colors.onPrimary
  }
})
