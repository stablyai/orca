import { StyleSheet } from 'react-native'
import { colors, feedback, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { WORKTREE_ROW_LAYOUT } from './worktree-list-row-layout'

export const worktreeListRowStyles = themedStyleSheet(() => ({
  worktreeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.lg,
    // Reserve the active accent bar width so active/inactive rows align.
    borderLeftWidth: WORKTREE_ROW_LAYOUT.accentWidth,
    borderLeftColor: 'transparent'
  },
  worktreeRowPressed: {
    backgroundColor: colors.bgRaised
  },
  // The active row already wears bgPanel, so its press needs a wash that reads over it.
  worktreeRowActivePressed: {
    backgroundColor: colors.translucentFill
  },
  // Match desktop focused-worktree card with raised fill and left accent.
  worktreeRowActive: {
    backgroundColor: colors.bgPanel,
    // Use desktop active-tab neutral accent, not blue.
    borderLeftColor: colors.textSecondary
  },
  indicatorCol: {
    width: WORKTREE_ROW_LAYOUT.indicatorWidth,
    alignItems: 'center',
    paddingTop: 6,
    marginRight: spacing.sm,
    gap: 4
  },
  unreadBell: {
    marginTop: 2
  },
  worktreeMain: {
    flex: 1
  },
  worktreeNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  worktreeName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    flexShrink: 1
  },
  worktreeNameUnread: {
    fontWeight: '700'
  },
  textReadOnly: {
    opacity: 0.5
  },
  prBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radii.pill
  },
  prNumber: {
    fontSize: 10,
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
  },
  terminalCount: {
    marginLeft: 'auto',
    fontSize: typography.metaSize,
    color: colors.textMuted
  }
}))
