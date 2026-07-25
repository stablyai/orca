import { StyleSheet } from 'react-native'
import { radii, spacing, type ThemeColors } from '../theme/mobile-theme'

// Born themed — split from tasks.tsx (no max-lines headroom).
export const createTasksScreenListStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    updatedAt: {
      fontSize: 11,
      color: colors.textMuted,
      paddingTop: 2
    },

    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 4,
      gap: spacing.xs
    },

    repoDot: {
      width: 7,
      height: 7,
      borderRadius: 4
    },

    pickerRepoDot: {
      width: 9,
      height: 9,
      borderRadius: 4.5
    },

    subtitle: {
      flex: 1,
      fontSize: 11,
      color: colors.textSecondary
    },

    branchMetaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginTop: 3,
      minWidth: 0
    },

    branchMetaText: {
      flexShrink: 1,
      minWidth: 0,
      maxWidth: 180,
      fontSize: 11,
      color: colors.textPrimary
    },

    branchMetaBase: {
      flexShrink: 1,
      minWidth: 0,
      fontSize: 10,
      color: colors.textMuted
    },

    prSignalRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      marginTop: spacing.xs + 1
    },

    prSignalChip: {
      alignSelf: 'flex-start',
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      borderRadius: radii.button,
      backgroundColor: colors.bgPanel,
      paddingHorizontal: spacing.xs + 2,
      paddingVertical: 2
    },

    prSignalSuccess: {
      borderColor: colors.statusGreen
    },

    prSignalWarning: {
      borderColor: colors.statusAmber
    },

    prSignalDanger: {
      borderColor: colors.statusRed
    },

    prSignalText: {
      fontSize: 10,
      color: colors.textSecondary,
      fontWeight: '600'
    },

    statusPill: {
      maxWidth: 112,
      backgroundColor: colors.bgRaised,
      borderRadius: 999,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
      borderWidth: 1,
      borderColor: colors.borderSubtle
    },

    statusPillSelf: {
      alignSelf: 'flex-start',
      backgroundColor: colors.bgRaised,
      borderRadius: 999,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      marginTop: spacing.sm
    },

    linearStatePill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs
    },

    linearStateDot: {
      width: 7,
      height: 7,
      borderRadius: 4
    },

    linearListTrailing: {
      alignItems: 'flex-end',
      gap: spacing.xs
    },

    taskRowTrailing: {
      alignItems: 'flex-end',
      gap: spacing.xs
    },

    statusText: {
      fontSize: 11,
      color: colors.textSecondary
    },

    statusTextFlex: {
      flex: 1,
      minWidth: 0
    },

    paginationFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.sm
    },

    paginationButton: {
      width: 44,
      minHeight: 38,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      borderRadius: radii.button,
      backgroundColor: colors.bgRaised,
      paddingVertical: spacing.sm
    },

    paginationButtonDisabled: {
      opacity: 0.45
    },

    paginationLabel: {
      color: colors.textSecondary,
      fontSize: 12,
      textAlign: 'center'
    },

    paginationLabelButton: {
      flex: 1,
      alignItems: 'center',
      borderRadius: radii.button,
      paddingHorizontal: spacing.xs,
      paddingVertical: spacing.sm
    },

    boardContainer: {
      gap: spacing.md,
      padding: spacing.md
    },

    boardColumn: {
      width: 280,
      maxHeight: '100%',
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      borderRadius: radii.card,
      backgroundColor: colors.bgPanel,
      overflow: 'hidden'
    },

    boardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderSubtle
    },

    boardTitle: {
      flex: 1,
      color: colors.textPrimary,
      fontSize: 13,
      fontWeight: '600'
    },

    boardCount: {
      color: colors.textMuted,
      fontSize: 11
    },

    boardCard: {
      margin: spacing.sm,
      marginBottom: 0,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      backgroundColor: colors.bgBase,
      padding: spacing.md
    },

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
    }
  })
