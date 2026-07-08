import { StyleSheet } from 'react-native'
import { spacing, radii, typography, type ThemeColors } from '../../../src/theme/mobile-theme'

export const createTaskScreenDetailStyles = (colors: ThemeColors) =>
  StyleSheet.create({
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
    },
    workspaceCreateForm: {
      gap: 0
    },
    workspaceCreateField: {
      marginBottom: spacing.md
    },
    workspaceCreateLabel: {
      fontSize: 13,
      fontWeight: '500',
      color: colors.textSecondary,
      marginBottom: spacing.xs
    },
    workspaceCreateLabelHint: {
      fontWeight: '400',
      color: colors.textMuted
    },
    workspaceAdvancedToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.sm,
      marginBottom: spacing.xs
    },
    workspaceAdvancedText: {
      fontSize: typography.bodySize,
      fontWeight: '500',
      color: colors.textSecondary
    },
    workspaceCreateActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginTop: spacing.sm
    },
    workspaceCreateButton: {
      minWidth: 160,
      paddingHorizontal: spacing.lg
    },
    sshConnectCard: {
      backgroundColor: colors.bgRaised,
      borderRadius: radii.input,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      gap: spacing.xs
    },
    sshStatusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm
    },
    sshStatusDot: {
      width: 8,
      height: 8,
      borderRadius: 999
    },
    sshStatusDotConnected: {
      backgroundColor: colors.statusGreen
    },
    sshStatusDotProgress: {
      backgroundColor: colors.statusAmber
    },
    sshStatusDotDisconnected: {
      backgroundColor: colors.statusRed
    },
    sshStatusCopy: {
      flex: 1,
      minWidth: 0
    },
    sshStatusTitle: {
      fontSize: typography.bodySize,
      color: colors.textPrimary,
      fontWeight: '600'
    },
    reviewerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      borderRadius: radii.card,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs
    },
    reviewerAvatar: {
      width: 24,
      height: 24,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.bgRaised
    },
    reviewerAvatarText: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.textSecondary
    },
    reviewerInfo: {
      flex: 1,
      minWidth: 0
    },
    reviewerName: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.textPrimary
    },
    reviewerMeta: {
      fontSize: 11,
      color: colors.textMuted
    },
    reviewerState: {
      flexShrink: 0,
      fontSize: 11,
      color: colors.textSecondary
    },
    projectFieldCard: {
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      borderRadius: radii.card,
      padding: spacing.sm,
      gap: spacing.xs
    },
    projectFieldName: {
      flex: 1,
      minWidth: 0,
      fontSize: 12,
      fontWeight: '600',
      color: colors.textPrimary
    },
    projectFieldValue: {
      maxWidth: 140,
      fontSize: 12,
      color: colors.textMuted
    },
    projectIterationList: {
      gap: spacing.xs
    },
    projectIterationCopy: {
      flex: 1,
      minWidth: 0,
      gap: 2
    },
    detailLine: {
      fontSize: 12,
      lineHeight: 17,
      color: colors.textSecondary
    },
    fileActionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      paddingVertical: 2
    }
  })
