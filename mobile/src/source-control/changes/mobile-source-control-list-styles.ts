import { StyleSheet } from 'react-native'
import { radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { COMPOSER_CONTROL_SIZE } from '../../components/composer-input/composer-input-styles'

export const listStylesSheet = themedStyleSheet((colors) => ({
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
  // ListRow's measures (48 pt, 60 with a folder line). Opaque so a left swipe uncovers Discard only as the row slides.
  // 2 pt either side of the 44 pt stage button keeps one-line rows at 48.
  fileRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 2,
    backgroundColor: colors.bgBase,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  fileRowTwoLine: {
    minHeight: 60
  },
  // A translucent wash over the opaque row: bgPanel is all but the page's own colour in light mode.
  fileRowPressed: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.translucentFill
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
    fontSize: 15
  },
  fileNameGone: {
    color: colors.textSecondary,
    textDecorationLine: 'line-through'
  },
  fileMeta: {
    color: colors.textSecondary,
    fontSize: 13,
    marginTop: 2
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: radii.control,
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
    backgroundColor: colors.translucentFill
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
  commitFailure: {
    gap: spacing.xs
  },
  commitFailureLinks: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xl,
    minHeight: 28
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
