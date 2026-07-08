import { Platform, StyleSheet } from 'react-native'
import { spacing, radii, typography, type ThemeColors } from '../../../src/theme/mobile-theme'

export const createTaskScreenProjectPickerStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    repoPickerGroup: {
      backgroundColor: colors.bgPanel,
      borderRadius: 12,
      overflow: 'hidden'
    },
    pagePickerList: {
      maxHeight: 420,
      backgroundColor: colors.bgPanel,
      borderRadius: 12
    },
    projectPickerControls: {
      gap: spacing.sm,
      marginBottom: spacing.md
    },
    projectWarningBanner: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      marginBottom: spacing.md,
      borderWidth: 1,
      borderColor: colors.statusAmber,
      borderRadius: radii.card,
      backgroundColor: colors.bgPanel
    },
    projectWarningTextWrap: {
      flex: 1,
      minWidth: 0
    },
    projectWarningTitle: {
      color: colors.textPrimary,
      fontSize: 12,
      fontWeight: '600'
    },
    projectWarningText: {
      color: colors.textSecondary,
      fontSize: 11,
      marginTop: 2
    },
    projectDataNotice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: colors.bgPanel,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderSubtle
    },
    projectDataNoticeText: {
      flex: 1,
      color: colors.statusAmber,
      fontSize: 13
    },
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
    }
  })
