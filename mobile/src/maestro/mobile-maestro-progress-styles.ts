import { StyleSheet } from 'react-native'
import { radii, spacing, typography, type MobileThemeColors } from '../theme/mobile-theme'

export function createMobileMaestroProgressStyles(colors: MobileThemeColors) {
  return StyleSheet.create({
    phoneSummary: {
      position: 'absolute',
      top: spacing.sm,
      left: spacing.md,
      right: spacing.md,
      maxWidth: 380,
      minHeight: 96,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      borderRadius: 10,
      backgroundColor: colors.bgPanel,
      zIndex: 35,
      elevation: 8
    },
    summaryTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    summaryTitle: {
      flex: 1,
      color: colors.textPrimary,
      fontSize: typography.bodySize,
      fontWeight: '600',
      letterSpacing: -0.1
    },
    summaryMetaRow: {
      marginTop: spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm
    },
    summaryStatus: { color: colors.textSecondary, fontSize: typography.metaSize },
    summaryProgress: {
      color: colors.textPrimary,
      fontSize: typography.metaSize,
      fontWeight: '600'
    },
    summaryProgressTrack: {
      height: 3,
      marginTop: spacing.sm,
      overflow: 'hidden',
      borderRadius: 2,
      backgroundColor: colors.bgRaised,
      flexDirection: 'row'
    },
    summaryProgressFill: { height: 3, borderRadius: 2, backgroundColor: colors.textPrimary },
    summaryFooter: {
      marginTop: spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm
    },
    summaryCounts: { flex: 1, color: colors.textMuted, fontSize: 10 },
    summaryWarning: { color: colors.statusAmber, fontSize: 10, fontWeight: '600' },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    statusDot: { width: 8, height: 8, borderRadius: 4 },
    statusNeutral: { backgroundColor: colors.textSecondary },
    statusSuccess: { backgroundColor: colors.statusGreen },
    statusWarning: { backgroundColor: colors.statusAmber },
    statusDanger: { backgroundColor: colors.statusRed },
    statusText: { color: colors.textSecondary, fontSize: typography.metaSize, fontWeight: '600' },
    tabletPane: {
      width: 360,
      borderLeftWidth: 1,
      borderLeftColor: colors.borderSubtle,
      backgroundColor: colors.bgPanel
    },
    tabletContent: { padding: spacing.lg, paddingBottom: spacing.xl },
    drawerHeader: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderSubtle
    },
    drawerTitle: {
      flex: 1,
      color: colors.textPrimary,
      fontSize: typography.titleSize,
      fontWeight: '700'
    },
    iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    detailContent: { paddingVertical: spacing.lg, gap: spacing.lg },
    runHeader: { gap: spacing.sm },
    runTitle: { color: colors.textPrimary, fontSize: typography.titleSize, fontWeight: '700' },
    runMetaRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
    progressLabel: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '700' },
    countsLabel: { color: colors.textMuted, fontSize: typography.metaSize, lineHeight: 17 },
    progressTrack: {
      height: 4,
      overflow: 'hidden',
      borderRadius: 2,
      backgroundColor: colors.bgRaised,
      flexDirection: 'row'
    },
    progressFill: { height: 4, borderRadius: 2, backgroundColor: colors.textPrimary },
    section: { gap: spacing.sm },
    sectionTitle: {
      color: colors.textMuted,
      fontSize: 10,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.7
    },
    entry: {
      paddingTop: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: colors.borderSubtle,
      gap: spacing.xs
    },
    entryTop: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
    entryTitle: {
      flex: 1,
      color: colors.textPrimary,
      fontSize: typography.bodySize,
      fontWeight: '600'
    },
    entryState: { color: colors.textSecondary, fontSize: 10, fontWeight: '600' },
    entryLabel: { color: colors.textSecondary, fontSize: typography.metaSize },
    entryDetail: { color: colors.textMuted, fontSize: typography.metaSize, lineHeight: 17 },
    warning: {
      padding: spacing.md,
      borderWidth: 1,
      borderColor: colors.statusAmber,
      borderRadius: radii.button,
      backgroundColor: colors.bgRaised,
      gap: spacing.xs
    },
    warningTitle: { color: colors.statusAmber, fontSize: typography.metaSize, fontWeight: '700' },
    warningDetail: { color: colors.textSecondary, fontSize: typography.metaSize, lineHeight: 17 },
    technicalRow: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: colors.borderSubtle
    },
    technicalText: { flex: 1, gap: spacing.xs },
    technicalLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '600' },
    technicalValue: {
      color: colors.textSecondary,
      fontSize: 10,
      fontFamily: typography.monoFamily
    }
  })
}
