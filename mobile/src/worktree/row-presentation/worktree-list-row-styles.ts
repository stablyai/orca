import { StyleSheet } from 'react-native'
import { colors, feedback, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { WORKTREE_ROW_LAYOUT } from './worktree-list-row-layout'

const TITLE_LINE_HEIGHT = 20
const ROW_PADDING_VERTICAL = 10

export const worktreeListRowStyles = themedStyleSheet(() => ({
  worktreeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: ROW_PADDING_VERTICAL,
    paddingHorizontal: WORKTREE_ROW_LAYOUT.indicatorInset
  },
  // The desktop's paused bot: its row and workspaces at 60%.
  worktreeRowDimmed: {
    opacity: 0.6
  },
  worktreeRowPressed: {
    backgroundColor: colors.bgRaised
  },
  // The status glyph (12 pt) centred on the title's 20 pt line.
  indicatorCol: {
    width: WORKTREE_ROW_LAYOUT.indicatorWidth,
    alignItems: 'flex-start',
    paddingTop: (TITLE_LINE_HEIGHT - 12) / 2,
    gap: spacing.xs
  },
  unreadBell: {
    marginTop: 2,
    marginLeft: 1
  },
  worktreeMain: {
    flex: 1
  },
  worktreeNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: TITLE_LINE_HEIGHT
  },
  worktreeName: {
    fontSize: 16,
    lineHeight: TITLE_LINE_HEIGHT,
    fontWeight: '400',
    color: colors.textPrimary,
    flexShrink: 1
  },
  // The repo's own checkout: present, but quieter than the work around it.
  worktreeNameMain: {
    color: colors.textSecondary
  },
  worktreeNameUnread: {
    fontWeight: '600'
  },
  time: {
    marginLeft: 'auto',
    paddingLeft: spacing.sm,
    fontSize: 13,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  detail: {
    marginTop: spacing.xxs,
    fontSize: 14,
    lineHeight: 18,
    color: colors.textMuted
  },
  moreAgents: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 30
  },
  moreAgentsText: {
    fontSize: 14,
    color: colors.textMuted
  },
  textReadOnly: {
    opacity: 0.5
  },
  prBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3
  },
  prNumber: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary
  },
  // Why: matches the desktop's compact repo chip, a small framed icon ahead of the title.
  repoChip: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.mark,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  folderBadge: {
    backgroundColor: colors.bgRaised,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radii.pill
  },
  folderBadgeText: {
    fontSize: 10,
    color: colors.textSecondary
  },
  worktreeMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
    gap: spacing.xs
  },
  repoName: {
    fontSize: 11,
    color: colors.textSecondary,
    maxWidth: 100
  },
  branchName: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    // Why: path takes only leftover space so badges truncate last.
    flex: 1
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
  },
  lineageToggle: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xs,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.control
  },
  lineageTogglePressed: {
    opacity: feedback.pressedOpacity
  },
  lineageToggleText: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: '600'
  }
}))
