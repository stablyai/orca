import { StyleSheet } from 'react-native'
import {
  LIST_LEADING_INSET,
  LIST_LEADING_SLOT,
  LIST_ROW_PADDING
} from '../components/list/ListGroup'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const styles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  header: {
    backgroundColor: colors.bgBase
  },
  scopeTabs: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    backgroundColor: colors.bgPanel
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: LIST_LEADING_INSET,
    backgroundColor: colors.borderSubtle
  },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: spacing.md
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  leading: {
    width: LIST_LEADING_SLOT,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center'
  },
  main: {
    flex: 1,
    minWidth: 0,
    gap: 3
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    fontSize: 15,
    lineHeight: 18,
    fontWeight: '600'
  },
  timeAgo: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontVariant: ['tabular-nums']
  },
  chevronExpanded: { transform: [{ rotate: '180deg' }] },
  lastMessage: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 16
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 1
  },
  metaText: {
    flexShrink: 1,
    minWidth: 0,
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: 16,
    fontVariant: ['tabular-nums']
  },
  currentBadge: {
    flexShrink: 1,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.pill,
    paddingHorizontal: 6,
    paddingVertical: 1
  },
  currentBadgeText: {
    color: colors.accentBlue,
    fontSize: 11,
    fontWeight: '600'
  },
  // A round play button beside the text, so it never crowds the lines.
  resumeButton: {
    alignSelf: 'center',
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised
  },
  resumeButtonPressed: {
    opacity: 0.7
  },
  resumeButtonDisabled: {
    opacity: 0.45
  },
  preview: {
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    gap: spacing.sm
  },
  previewTurn: {
    gap: 2
  },
  previewRole: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  previewText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 17
  }
}))
