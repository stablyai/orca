import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

// Empty-state, retry, and committed-diff-preview drawer styles. Split from the
// main source-control stylesheet to stay under the line limit.
export const diffStyles = StyleSheet.create({
  state: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl
  },
  stateTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: spacing.xs
  },
  stateText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 20,
    textAlign: 'center'
  },
  retryButton: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  retryText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  diffDrawerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  diffDrawerTitleBlock: {
    flex: 1,
    minWidth: 0
  },
  diffDrawerTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  diffDrawerMeta: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: 2
  },
  diffCloseButton: {
    width: 34,
    height: 34,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center'
  },
  diffState: {
    minHeight: 160,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg
  },
  diffLines: {
    paddingTop: spacing.md,
    paddingBottom: spacing.lg
  },
  diffTruncatedText: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginBottom: spacing.sm
  },
  diffLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    paddingVertical: 2,
    paddingHorizontal: spacing.xs
  },
  diffLineAdd: {
    backgroundColor: colors.diffAddedBg
  },
  diffLineDelete: {
    backgroundColor: colors.diffDeletedBg
  },
  diffLineNumber: {
    width: 40,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    textAlign: 'right'
  },
  diffLinePrefix: {
    width: 12,
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  diffLineText: {
    flex: 1,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 17
  }
})
