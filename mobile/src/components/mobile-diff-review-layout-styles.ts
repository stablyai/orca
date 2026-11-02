import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const mobileDiffReviewLayoutStyles = themedStyleSheet(() => ({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center'
  },
  iconButtonPressed: {
    backgroundColor: colors.borderSubtle
  },
  staleText: {
    color: colors.statusAmber,
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  fileNotes: {
    gap: spacing.xs,
    marginTop: spacing.sm
  },
  fileNote: {
    minHeight: 44,
    padding: spacing.sm,
    borderRadius: radii.surface,
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  fileNotePressed: {
    backgroundColor: colors.bgRaised
  },
  fileNoteText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 17
  },
  actionError: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.surface,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.statusAmber
  },
  actionErrorText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize
  },
  foldRow: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.bgPanel
  },
  foldText: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  diffListFrame: {
    flex: 1
  },
  threadRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgBase
  },
  diffList: {
    paddingBottom: 140,
    backgroundColor: colors.editorSurface
  },
  truncatedText: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    padding: spacing.md,
    textAlign: 'center'
  },
  state: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md
  },
  stateTitle: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '700',
    textAlign: 'center'
  },
  stateText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    textAlign: 'center',
    lineHeight: 20
  },
  retryButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  retryText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  }
}))
