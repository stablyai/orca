import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { COMPOSER_CONTROL_SIZE } from '../components/composer-input/composer-input-styles'

export const listStyles = themedStyleSheet(() => ({
  listContent: {
    paddingHorizontal: spacing.lg
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.md,
    paddingBottom: spacing.xs
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase'
  },
  sectionCount: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  branchCompareBlock: {
    paddingBottom: spacing.sm
  },
  branchSectionTitleBlock: {
    flex: 1,
    minWidth: 0
  },
  branchSectionSubtitle: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: 2
  },
  branchStateRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  branchStateText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 18
  },
  fileRow: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  fileRowPressed: {
    backgroundColor: colors.bgPanel
  },
  fileRowDisabled: {
    opacity: 0.78
  },
  fileRowUnavailable: {
    opacity: 0.72
  },
  statusBadge: {
    width: 24,
    alignItems: 'center'
  },
  statusBadgeText: {
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  fileTextBlock: {
    flex: 1,
    minWidth: 0
  },
  filePath: {
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  filePathDisabled: {
    color: colors.textSecondary
  },
  fileMeta: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: 2
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center'
  },
  conflictActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  conflictActionButton: {
    minHeight: 30,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  conflictActionText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  iconButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  iconButtonDisabled: {
    opacity: 0.45
  },
  commitBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    gap: spacing.xs,
    padding: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.bgPanel,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  // A capsule beside the composer's round controls; the action's name matters more than an arrow.
  commitButton: {
    height: COMPOSER_CONTROL_SIZE,
    borderRadius: COMPOSER_CONTROL_SIZE / 2,
    backgroundColor: colors.surfaceBright,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg
  },
  commitButtonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  commitButtonDisabled: {
    backgroundColor: colors.composerControl
  },
  commitButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  commitButtonSecondaryText: {
    color: colors.textPrimary
  },
  commitButtonDisabledText: {
    color: colors.textMuted
  },
  commitFailurePanel: {
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.statusRed,
    gap: spacing.sm
  },
  commitFailureHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  commitFailureTextBlock: {
    flex: 1,
    minWidth: 0
  },
  commitFailureTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  commitFailureSummary: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 16,
    marginTop: 2
  },
  commitFailureFixButton: {
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs
  },
  commitFailureFixButtonDisabled: {
    opacity: 0.45
  },
  commitFailureFixButtonPressed: {
    opacity: 0.75
  },
  commitFailureFixButtonText: {
    color: colors.bgBase,
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  commitFailureDetailsButton: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  commitFailureDetailsButtonPressed: {
    opacity: 0.75
  },
  commitFailureDetailsButtonText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  commitFailureDetailsText: {
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 17
  },
  commitFailureLaunchError: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    lineHeight: 16
  }
}))
