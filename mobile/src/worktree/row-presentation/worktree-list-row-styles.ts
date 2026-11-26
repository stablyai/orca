import { StyleSheet } from 'react-native'
import { colors, radii, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { WORKTREE_ROW_LAYOUT } from './worktree-list-row-layout'

/** One line per workspace, laid out like Home's grouped rows (home-list-styles.ts). */
export const worktreeListRowStyles = themedStyleSheet(() => ({
  // The project's group: each row carries its fill, the first and last round its corners.
  groupRow: {
    marginHorizontal: WORKTREE_ROW_LAYOUT.groupInset,
    backgroundColor: colors.bgPanel,
    overflow: 'hidden'
  },
  groupFirst: {
    borderTopLeftRadius: radii.surface,
    borderTopRightRadius: radii.surface
  },
  groupLast: {
    borderBottomLeftRadius: radii.surface,
    borderBottomRightRadius: radii.surface
  },
  // Between two rows of one group: the group's fill with a hairline from the text column. A whole
  // point tall, so rows below it stay on whole points and every hairline lands on a device pixel.
  groupSeparator: {
    height: 1,
    marginHorizontal: WORKTREE_ROW_LAYOUT.groupInset,
    backgroundColor: colors.bgPanel
  },
  groupSeparatorLine: {
    height: StyleSheet.hairlineWidth,
    marginLeft: WORKTREE_ROW_LAYOUT.textInset,
    backgroundColor: colors.borderSubtle
  },
  worktreeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingLeft: WORKTREE_ROW_LAYOUT.indicatorInset,
    // Opaque, so a swipe's actions stay hidden until the row slides off them.
    backgroundColor: colors.bgPanel
  },
  // The desktop's paused bot: its row and workspaces at 60%.
  worktreeRowDimmed: {
    opacity: 0.6
  },
  // The tablet sidebar's open workspace, filled like a pressed row.
  worktreeRowSelected: {
    backgroundColor: colors.bgRaised
  },
  worktreeRowPressed: {
    backgroundColor: colors.bgRaised
  },
  indicatorCol: {
    width: WORKTREE_ROW_LAYOUT.indicatorWidth,
    alignItems: 'flex-start',
    justifyContent: 'center'
  },
  worktreeMain: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 12
  },
  worktreeNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  worktreeName: {
    flexShrink: 1,
    fontSize: 16,
    lineHeight: 20,
    color: colors.textPrimary
  },
  worktreeNameUnread: {
    fontWeight: '600'
  },
  // The repo's own checkout: there in every project, so it reads quieter than the work.
  worktreeNameMain: {
    color: colors.textSecondary
  },
  textReadOnly: {
    opacity: 0.5
  },
  // Centred on the row like Home's trailing column; ends 14 from the group's edge.
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 10,
    paddingRight: 14
  },
  time: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  stateWord: {
    fontSize: 13,
    fontWeight: '600'
  },
  prMark: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2
  },
  prNumber: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    fontVariant: ['tabular-nums']
  },
  // A row's children fold: the count and a chevron, at the trailing edge.
  lineageToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2
  },
  lineageCount: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  childBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radii.pill
  },
  childBadgeText: {
    fontSize: 10,
    color: colors.textMuted
  },
  // Why the cap is on the name, not the badge: a health word after a long name must stay readable.
  hostBadge: {
    flexShrink: 1
  },
  hostBadgeText: {
    flexShrink: 1,
    maxWidth: 100
  },
  hostHealthText: {
    flexShrink: 0
  }
}))
