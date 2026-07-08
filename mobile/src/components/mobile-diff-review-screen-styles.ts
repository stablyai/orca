import type { ThemeColors } from '../theme/mobile-theme'
import { createMobileDiffReviewControlStyles } from './mobile-diff-review-control-styles'
import { createMobileDiffReviewLayoutStyles } from './mobile-diff-review-layout-styles'

export const createMobileDiffReviewStyles = (colors: ThemeColors) => ({
  ...createMobileDiffReviewLayoutStyles(colors),
  ...createMobileDiffReviewControlStyles(colors)
})
