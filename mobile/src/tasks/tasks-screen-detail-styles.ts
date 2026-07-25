import { Platform, StyleSheet } from 'react-native'
import { spacing, typography, type ThemeColors } from '../theme/mobile-theme'

// Born themed — split from tasks.tsx (no max-lines headroom).
export const createTasksScreenDetailStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    projectGroupHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: colors.bgPanel
    },

    projectGroupChevronCollapsed: {
      transform: [{ rotate: '-90deg' }]
    },

    projectGroupTitle: {
      flex: 1,
      minWidth: 0,
      color: colors.textPrimary,
      fontSize: 12,
      fontWeight: '600'
    },

    projectGroupMeta: {
      color: colors.textMuted,
      fontSize: 11
    },

    projectFieldPillRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      marginTop: spacing.xs
    },

    projectFieldPill: {
      maxWidth: '100%',
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      borderRadius: 999,
      backgroundColor: colors.bgPanel,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2
    },

    projectFieldPillText: {
      color: colors.textSecondary,
      fontSize: 11
    },

    projectFieldPillEmptyText: {
      color: colors.textMuted
    },

    projectPasteRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm
    },

    projectPasteInput: {
      flex: 1
    },

    projectPasteButton: {
      minHeight: 40,
      alignItems: 'center',
      justifyContent: 'center'
    },

    pickerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md + 2,
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderSubtle
    },

    pickerRowSelected: {
      backgroundColor: colors.bgRaised
    },

    pickerRowContent: {
      flex: 1,
      minWidth: 0
    },

    pickerRowLabel: {
      fontSize: typography.bodySize,
      color: colors.textPrimary
    },

    pickerRowSubtitle: {
      fontSize: 11,
      color: colors.textMuted,
      marginTop: 1
    },

    pickerRowWithAction: {
      flexDirection: 'row',
      alignItems: 'center'
    },

    pickerRowMain: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md + 2,
      paddingVertical: spacing.md
    },

    pickerCheck: {
      width: 18,
      alignItems: 'center'
    },

    pickerContent: {
      flex: 1,
      minWidth: 0
    },

    pickerLabel: {
      fontSize: typography.bodySize,
      color: colors.textPrimary
    },

    monoText: {
      fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })
    },

    pickerSubtitle: {
      fontSize: 11,
      color: colors.textMuted,
      marginTop: 1
    },

    iconActionButton: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center'
    },

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
    }
  })
