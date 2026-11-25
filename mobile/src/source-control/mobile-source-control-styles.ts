import { StyleSheet } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet, themedStyles } from '../theme/themed-styles'
import { diffStyles } from './changes/mobile-source-control-diff-styles'
import { listStyles } from './changes/mobile-source-control-list-styles'

const baseStyles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  // NavBar draws the bar and its border; this fills the safe-area inset above it.
  header: {
    backgroundColor: colors.bgBase
  },
  statusLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.xs
  },
  // A 44 pt row target, as tall as the touch it takes.
  branchButton: {
    flexShrink: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  branchText: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '500'
  },
  conflictNote: {
    paddingBottom: spacing.sm,
    color: colors.textSecondary,
    fontSize: 13
  },
  commitsRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  commitsRowPressed: {
    backgroundColor: colors.translucentFill
  },
  commitsRowText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 15
  },
  syncText: {
    marginLeft: 'auto',
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  // One quiet line for every state and error above the list: no boxes, no borders.
  feedbackLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.sm
  },
  feedbackText: {
    flexShrink: 1,
    paddingTop: spacing.sm,
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18
  },
  feedbackError: {
    color: colors.statusRed
  }
}))

export const styles = themedStyles(() => ({ ...baseStyles, ...listStyles, ...diffStyles }))
