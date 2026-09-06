import { StyleSheet, colors, radii, spacing, typography } from './mobile-tasks-dependencies'

export const mobileTasksDetailStyles = StyleSheet.create({
  groupSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  repoPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md
  },
  repoPickerTextWrap: {
    flex: 1,
    minWidth: 0
  },
  repoPickerTitle: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  repoPickerSubtitle: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1
  },
  sheetHeader: {
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  sheetTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  sheetTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    fontWeight: '700',
    color: colors.textPrimary,
    lineHeight: 20
  },
  sheetSubtitle: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2
  },
  actionGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  detailGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.md
  },
  detailLoading: {
    paddingVertical: spacing.lg,
    alignItems: 'center'
  },
  detailLoadingInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  detailError: {
    color: colors.statusRed,
    fontSize: 13
  },
  detailMetaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm
  },
  detailMetaItem: {
    minWidth: 96,
    flexGrow: 1
  },
  detailMetaLabel: {
    fontSize: 11,
    color: colors.textMuted,
    marginBottom: 2
  },
  detailMetaValue: {
    fontSize: 13,
    color: colors.textPrimary,
    fontWeight: '600'
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs
  },
  detailChip: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2
  },
  detailChipSelected: {
    borderColor: colors.accentBlue,
    backgroundColor: colors.bgRaised
  },
  detailChipText: {
    fontSize: 11,
    color: colors.textSecondary
  },
  issueTypeChipContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  issueTypeDot: {
    width: 7,
    height: 7,
    borderRadius: 999
  },
  detailSection: {
    gap: spacing.xs
  },
  detailSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  detailSectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  detailSectionMeta: {
    flexShrink: 0,
    fontSize: 11,
    color: colors.textMuted
  },
  fieldButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  fieldButtonDisabled: {
    opacity: 0.55
  },
  fieldButtonPlaceholder: {
    color: colors.textMuted
  },
  fieldButtonText: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  }
})
