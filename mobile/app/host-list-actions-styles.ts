import { StyleSheet } from 'react-native'
import { spacing, radii, type ThemeColors } from '../src/theme/mobile-theme'

export const createHostListActionsStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    taskHomeCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.bgPanel,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      borderRadius: radii.card,
      minHeight: 72,
      paddingLeft: spacing.md,
      paddingRight: spacing.md,
      paddingVertical: 12
    },
    taskHomeIcon: {
      width: 46,
      height: 46,
      borderRadius: 13,
      backgroundColor: colors.bgRaised,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 14
    },
    taskHomeMain: {
      flex: 1,
      minWidth: 0
    },
    taskHomeTitle: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textPrimary
    },
    taskHomeSubtitle: {
      fontSize: 12,
      color: colors.textSecondary,
      marginTop: 3
    },
    taskHomeTrailing: {
      flexDirection: 'row',
      alignItems: 'center',
      flexShrink: 0,
      marginLeft: spacing.sm
    },
    taskHomeProviderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 2
    },
    taskHomeProviderButton: {
      width: 34,
      height: 34,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radii.button
    },
    taskHomeProviderButtonPressed: {
      backgroundColor: colors.bgRaised
    },
    accountsCard: {
      backgroundColor: colors.bgPanel,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      borderRadius: radii.card,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      gap: spacing.sm,
      marginBottom: spacing.sm
    },
    accountsHostLabel: {
      fontSize: 11,
      color: colors.textMuted,
      fontWeight: '500',
      textTransform: 'uppercase',
      letterSpacing: 0.4
    },
    accountsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm + 2
    },
    accountsIcon: {
      width: 32,
      height: 32,
      borderRadius: 9,
      backgroundColor: colors.bgRaised,
      alignItems: 'center',
      justifyContent: 'center'
    },
    accountsInfo: {
      flex: 1,
      minWidth: 0,
      gap: 2
    },
    accountsEmail: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textPrimary
    },
    accountsBars: {
      flexDirection: 'row',
      gap: spacing.md,
      marginTop: 4
    },
    quickActions: {
      flexDirection: 'row',
      gap: spacing.sm
    },
    quickAction: {
      flex: 1,
      flexDirection: 'row',
      backgroundColor: colors.bgPanel,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      borderRadius: radii.card,
      paddingVertical: 10,
      paddingHorizontal: 12,
      alignItems: 'center',
      gap: 10
    },
    quickActionDisabled: {
      opacity: 0.45
    },
    quickActionIcon: {
      width: 28,
      height: 28,
      borderRadius: 9,
      backgroundColor: colors.bgRaised,
      alignItems: 'center',
      justifyContent: 'center'
    },
    quickActionLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.textSecondary
    },
    emptyContainer: {
      flex: 1
    },
    emptyGreeting: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.sm
    },
    emptyHero: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
      paddingBottom: 40
    },
    emptyTitle: {
      fontSize: 22,
      fontWeight: '700',
      color: colors.textPrimary,
      textAlign: 'center',
      marginBottom: 10
    },
    emptyBody: {
      fontSize: 15,
      color: colors.textSecondary,
      textAlign: 'center',
      lineHeight: 22,
      marginBottom: 32
    },
    primaryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: colors.textPrimary,
      paddingHorizontal: 28,
      paddingVertical: 14,
      borderRadius: radii.card
    },
    primaryButtonText: {
      color: colors.bgBase,
      fontSize: 15,
      fontWeight: '700'
    },
    stepsSection: {
      paddingHorizontal: spacing.xl
    },
    stepRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 14,
      paddingVertical: spacing.lg
    },
    stepRowBorder: {
      borderTopWidth: 1,
      borderTopColor: colors.borderSubtle
    },
    stepNum: {
      width: 28,
      height: 28,
      borderRadius: 8,
      backgroundColor: colors.bgRaised,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1
    },
    stepNumText: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.textSecondary
    },
    stepText: {
      flex: 1
    },
    stepTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.textPrimary,
      marginBottom: 3
    },
    stepDesc: {
      fontSize: 12,
      color: colors.textMuted,
      lineHeight: 17
    }
  })
