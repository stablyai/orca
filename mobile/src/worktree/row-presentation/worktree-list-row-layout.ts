import { spacing } from '../../theme/mobile-theme'

const INDICATOR_WIDTH = 24

/** The workspace row's horizontal grid; section headers and separators line up with it. */
export const WORKTREE_ROW_LAYOUT = {
  /** Left edge of the status-dot column. */
  indicatorInset: spacing.lg,
  indicatorWidth: INDICATOR_WIDTH,
  /** Where the row's text starts. */
  textInset: spacing.lg + INDICATOR_WIDTH
} as const
