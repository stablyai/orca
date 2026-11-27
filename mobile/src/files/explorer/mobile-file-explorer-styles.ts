import { colors, feedback, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

export const fileExplorerStyles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  // Inside a sheet's tab, the tree sits on the sheet.
  onSheet: { backgroundColor: 'transparent' },
  header: {
    backgroundColor: colors.bgBase
  },
  list: { flex: 1 },
  listContent: {
    paddingVertical: spacing.sm
  },
  // ListRow's measures: 48 pt, 15 pt names, a 24 pt icon slot, 12 pt before the text.
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.lg
  },
  resultRow: {
    minHeight: 60,
    paddingLeft: spacing.lg
  },
  // A translucent wash: bgRaised is the page's own colour in light mode and on sheets.
  rowPressed: {
    backgroundColor: colors.translucentFill
  },
  rowDisabled: {
    opacity: feedback.disabledOpacity
  },
  chevronSpacer: {
    width: 16
  },
  iconSlot: {
    width: 24,
    marginRight: spacing.xs,
    alignItems: 'center'
  },
  name: {
    flexDirection: 'row',
    minWidth: 0
  },
  nameStart: {
    flexShrink: 1
  },
  nameEnd: {
    flexShrink: 0
  },
  rowTextBlock: {
    flex: 1,
    minWidth: 0
  },
  rowTitle: {
    color: colors.textPrimary,
    fontSize: 15
  },
  rowFolder: {
    marginTop: 2,
    color: colors.textSecondary,
    fontSize: 13
  },
  // Desktop sets ignored names in italics as well as dimming them.
  rowTitleIgnored: {
    fontStyle: 'italic'
  },
  // Same letter badge as the Source Control rows.
  statusLetter: {
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  inlineStatusRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.md
  },
  inlineStatusText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  inlineStatusFill: {
    flex: 1,
    minWidth: 0,
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  showMoreText: {
    color: colors.accentBlue,
    fontSize: 15,
    fontWeight: '500'
  },
  entryCount: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  inlineErrorText: {
    flex: 1,
    minWidth: 0,
    color: colors.statusRed,
    fontSize: typography.metaSize
  },
  // A text action on the error's line, 44 pt tall.
  inlineRetryButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm
  },
  inlineRetryText: {
    color: colors.accentBlue,
    fontSize: 15,
    fontWeight: '500'
  }
}))
