import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const hubStyles = themedStyleSheet(() => ({
  segments: {
    flexDirection: 'row',
    alignItems: 'stretch',
    width: '100%',
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  segment: {
    flex: 1,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    // Reserve underline height so selection cannot shift layout.
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  segmentActive: {
    borderBottomColor: colors.textPrimary
  },
  segmentPressed: {
    opacity: 0.7
  },
  segmentText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  segmentTextActive: {
    color: colors.textPrimary
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  chipPressed: {
    opacity: 0.7
  },
  chipIcon: {
    width: 18,
    alignItems: 'center'
  },
  chipNumber: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  statePill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth
  },
  statePillText: {
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  rollup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4
  },
  rollupText: {
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  comment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4
  },
  commentText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  chipSpacer: {
    flex: 1,
    minWidth: spacing.sm
  },
  chipCreateText: {
    color: colors.accentBlue,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  chipMutedText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  changesControls: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xs
  },
  tabBody: {
    flex: 1
  },
  tabBodyHidden: {
    display: 'none'
  }
}))
