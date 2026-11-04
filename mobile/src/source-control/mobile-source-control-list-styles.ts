import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { COMPOSER_CONTROL_SIZE } from '../components/composer-input/composer-input-styles'

export const listStyles = themedStyleSheet(() => ({
  listContent: {
    paddingHorizontal: spacing.lg
  },
  // SectionHeader brings its own row padding, so it reaches past the list's.
  sectionHeaderBleed: {
    marginHorizontal: -spacing.lg
  },
  sectionAction: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600'
  },
  sectionActions: {
    flexDirection: 'row',
    gap: spacing.lg
  },
  sectionActionPressed: {
    opacity: 0.6
  },
  sectionMeta: {
    color: colors.textSecondary,
    fontSize: 13
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
  // Opaque so a left swipe uncovers Discard only as the row slides.
  fileRow: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgBase,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  fileRowPressed: {
    backgroundColor: colors.bgPanel
  },
  fileRowUnavailable: {
    opacity: 0.72
  },
  // Leading-aligned so the status letter starts on the section label's edge.
  statusBadge: {
    width: 24,
    alignItems: 'flex-start'
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
  fileName: {
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  fileNameGone: {
    color: colors.textSecondary,
    textDecorationLine: 'line-through'
  },
  fileMeta: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: 2
  },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center'
  },
  // Behind the row's right end; the row slides left to uncover it.
  discardAction: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: 84,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    backgroundColor: colors.statusRed
  },
  discardActionText: {
    color: colors.onStatusRed,
    fontSize: typography.metaSize,
    fontWeight: '600'
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
    borderRadius: radii.control,
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
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    backgroundColor: colors.bgPanel,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  // A capsule beside the composer's round controls; the action's name matters more than an arrow.
  commitButton: {
    height: COMPOSER_CONTROL_SIZE,
    borderRadius: radii.pill,
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
    borderRadius: radii.surface,
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
    borderRadius: radii.control,
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
