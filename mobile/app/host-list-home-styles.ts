import { StyleSheet } from 'react-native'
import { spacing, radii, type ThemeColors } from '../src/theme/mobile-theme'

export const createHostListHomeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.bgBase
    },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md
    },
    brandLockup: {
      flexDirection: 'row',
      alignItems: 'center',
      minWidth: 0
    },
    logoMark: {
      marginRight: spacing.sm
    },
    brandName: {
      color: colors.textPrimary,
      fontSize: 17,
      fontWeight: '700'
    },
    iconButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center'
    },
    iconButtonPressed: {
      backgroundColor: colors.bgRaised
    },
    hero: {
      paddingTop: spacing.xs,
      paddingBottom: spacing.md
    },
    heroTitle: {
      color: colors.textPrimary,
      fontSize: 24,
      fontWeight: '800',
      letterSpacing: -0.3
    },
    statsRow: {
      flexDirection: 'row',
      gap: 10,
      marginBottom: spacing.lg
    },
    statCard: {
      flex: 1,
      backgroundColor: colors.bgPanel,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: spacing.md
    },
    statValue: {
      color: colors.textPrimary,
      fontSize: 18,
      fontWeight: '700',
      letterSpacing: -0.3
    },
    statLabel: {
      color: colors.textMuted,
      fontSize: 11,
      fontWeight: '500',
      marginTop: 2
    },
    sectionHeading: {
      fontSize: 11,
      fontWeight: '600',
      color: colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      marginBottom: spacing.sm,
      paddingHorizontal: spacing.xs
    },
    sectionHeadingTightTop: {
      marginTop: spacing.lg
    },
    list: {
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.xl
    },
    cardGap: {
      height: spacing.sm
    },
    hostCard: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: spacing.md,
      paddingRight: spacing.md,
      paddingVertical: 12,
      borderRadius: radii.card,
      backgroundColor: colors.bgPanel,
      borderWidth: 1,
      borderColor: colors.borderSubtle
    },
    hostCardPressed: {
      backgroundColor: colors.bgRaised
    },
    hostIcon: {
      width: 46,
      height: 46,
      borderRadius: 13,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.bgRaised,
      marginRight: 14,
      position: 'relative'
    },
    hostMain: {
      flex: 1,
      minWidth: 0,
      marginRight: spacing.sm
    },
    hostName: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
      lineHeight: 20
    },
    hostMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 3
    },
    hostMetaItem: {
      fontSize: 12,
      color: colors.textSecondary
    },
    hostMetaDot: {
      width: 3,
      height: 3,
      borderRadius: 1.5,
      backgroundColor: colors.textMuted,
      marginHorizontal: 8
    },
    statusDot: {
      width: 7,
      height: 7,
      borderRadius: 3.5
    },
    resumeCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.bgPanel,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      borderRadius: radii.card,
      paddingLeft: spacing.md,
      paddingRight: spacing.md,
      paddingVertical: 12
    },
    resumeIcon: {
      width: 46,
      height: 46,
      borderRadius: 13,
      backgroundColor: colors.bgRaised,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 14
    },
    resumeMain: {
      flex: 1,
      minWidth: 0
    },
    resumeTitle: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textPrimary
    },
    resumeSub: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 3
    },
    repoDot: {
      width: 7,
      height: 7,
      borderRadius: 3.5
    },
    resumeSubText: {
      fontSize: 12,
      color: colors.textSecondary,
      flex: 1
    }
  })
