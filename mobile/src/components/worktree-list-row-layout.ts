import { spacing } from '../theme/mobile-theme'

const ROW_ACCENT_WIDTH = 2
const INDICATOR_WIDTH = 20

/** The workspace row's horizontal grid; section headers and separators line up with it. */
export const WORKTREE_ROW_LAYOUT = {
  accentWidth: ROW_ACCENT_WIDTH,
  /** Left edge of the status-dot column. */
  indicatorInset: ROW_ACCENT_WIDTH + spacing.lg,
  indicatorWidth: INDICATOR_WIDTH,
  /** Where the row's text starts. */
  textInset: ROW_ACCENT_WIDTH + spacing.lg + INDICATOR_WIDTH + spacing.sm
} as const
