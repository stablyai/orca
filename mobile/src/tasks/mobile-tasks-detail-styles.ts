import { StyleSheet, colors, radii, spacing, textStyles } from './mobile-tasks-dependencies'

export const mobileTasksDetailStyles = StyleSheet.create({
  groupSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
    marginLeft: spacing.lg
  },
  repoPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  repoPickerTextWrap: {
    flex: 1,
    minWidth: 0
  },
  repoPickerTitle: {
    ...textStyles.body,
    color: colors.textPrimary
  },
  repoPickerSubtitle: {
    ...textStyles.subhead,
    color: colors.textSecondary
  },
  sheetHeader: {
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.md
  },
  sheetTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  sheetTitle: {
    ...textStyles.headline,
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary
  },
  sheetSubtitle: {
    ...textStyles.footnote,
    color: colors.textSecondary,
    marginTop: 2
  },
  actionGroup: {
    marginHorizontal: spacing.xs,
    backgroundColor: colors.groupFill,
    borderRadius: radii.group,
    overflow: 'hidden'
  },
  detailGroup: {
    gap: spacing.lg,
    marginBottom: spacing.md
  },
  detailLoading: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center'
  },
  detailLoadingInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.lg
  },
  detailError: {
    ...textStyles.footnote,
    color: colors.danger
  },
  detailMetaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md
  },
  detailMetaItem: {
    minWidth: 96,
    flexGrow: 1
  },
  detailMetaLabel: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textSecondary,
    marginBottom: 2
  },
  detailMetaValue: {
    ...textStyles.callout,
    color: colors.textPrimary
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6
  },
  detailChip: {
    minHeight: 28,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: colors.fill,
    borderRadius: radii.pill,
    paddingHorizontal: 10
  },
  detailChipSelected: {
    borderColor: colors.fieldBorderFocused,
    backgroundColor: colors.fillPressed
  },
  detailChipText: {
    ...textStyles.footnote,
    color: colors.textSecondary
  },
  issueTypeChipContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  issueTypeDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  detailSection: {
    gap: spacing.sm
  },
  detailSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  detailSectionTitle: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textMuted
  },
  detailSectionMeta: {
    ...textStyles.footnote,
    flexShrink: 0,
    color: colors.textMuted
  },
  fieldButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    backgroundColor: colors.fieldFill,
    borderRadius: radii.field,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.fieldBorder
  },
  fieldButtonDisabled: {
    opacity: 0.4
  },
  fieldButtonPlaceholder: {
    color: colors.textMuted
  },
  fieldButtonText: {
    ...textStyles.body,
    flex: 1,
    color: colors.textPrimary
  }
})
