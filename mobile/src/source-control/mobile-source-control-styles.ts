import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet, themedStyles } from '../theme/themed-styles'
import { diffStyles } from './mobile-source-control-diff-styles'
import { listStyles } from './mobile-source-control-list-styles'

const baseStyles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  // NavBar draws the bar and its border; this fills the safe-area inset above it.
  header: {
    backgroundColor: colors.bgBase
  },
  summaryCard: {
    margin: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.surface,
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md
  },
  branchLine: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  branchText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  syncText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  countRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.sm
  },
  countText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  // Keep Abort below counts so narrow cards cannot overflow.
  conflictRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
    maxWidth: '100%'
  },
  conflictText: {
    color: colors.statusAmber,
    fontSize: typography.metaSize,
    textTransform: 'capitalize'
  },
  abortButton: {
    minHeight: 32,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.statusAmber,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  completeMergeButton: {
    minHeight: 32,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.control,
    backgroundColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  completeMergeText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  abortPressed: {
    opacity: 0.75
  },
  abortButtonDisabled: {
    opacity: 0.45
  },
  abortText: {
    color: colors.statusAmber,
    fontSize: typography.bodySize,
    fontWeight: '600',
    textTransform: 'capitalize'
  },
  reconnectBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    marginBottom: -spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.surface,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.statusAmber
  },
  reconnectBannerText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize
  },
  actionError: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.surface,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.statusRed
  },
  actionErrorText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    lineHeight: 16
  },
  bulkRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md
  },
  bulkButton: {
    flex: 1,
    minHeight: 36,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.xs
  },
  bulkMenuButton: {
    width: 42,
    minHeight: 36,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  bulkButtonDisabled: {
    opacity: 0.45
  },
  bulkButtonPressed: {
    opacity: 0.75
  },
  bulkButtonText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  createPrBlock: {
    marginTop: spacing.md
  },
  createPrButton: {
    height: 42,
    borderRadius: radii.control,
    backgroundColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.md
  },
  createPrButtonDisabled: {
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  createPrButtonPressed: {
    opacity: 0.78
  },
  createPrButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  createPrButtonTextDisabled: {
    color: colors.textSecondary
  },
  createPrButtonHint: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    lineHeight: 16,
    textAlign: 'center',
    flexShrink: 1
  }
}))

export const styles = themedStyles(() => ({ ...baseStyles, ...listStyles, ...diffStyles }))
