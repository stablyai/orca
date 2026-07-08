import type { ThemeColors } from '../src/theme/mobile-theme'
import { createHostListHomeStyles } from './host-list-home-styles'
import { createHostListActionsStyles } from './host-list-actions-styles'

export const createHostListScreenStyles = (colors: ThemeColors) => ({
  ...createHostListHomeStyles(colors),
  ...createHostListActionsStyles(colors)
})
