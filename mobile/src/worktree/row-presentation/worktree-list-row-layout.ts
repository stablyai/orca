import { spacing } from '../../theme/mobile-theme'

const INDICATOR_WIDTH = 24

/** The workspace row's horizontal grid inside its project's group, as Home's rows lay out. */
export const WORKTREE_ROW_LAYOUT = {
  /** Left edge of the status-dot column. */
  indicatorInset: spacing.lg,
  indicatorWidth: INDICATOR_WIDTH,
  /** Where the row's text starts; hairlines start here too. */
  textInset: spacing.lg + INDICATOR_WIDTH,
  /** The group's inset from the screen edge. */
  groupInset: spacing.lg
} as const
