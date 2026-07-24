import type { ThemeColors } from '../../../src/theme/mobile-theme'
import { createHostScreenChromeStyles } from './host-screen-chrome-styles'
import { createHostWorktreeListStyles } from './host-worktree-list-styles'

// Merge the two cap-safe factories into the sheet HostScreen already expects.
export const createHostScreenStyles = (colors: ThemeColors) => ({
  ...createHostScreenChromeStyles(colors),
  ...createHostWorktreeListStyles(colors)
})
