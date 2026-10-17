import { createThemedStyles } from '../theme/mobile-themed-styles'
import { mobileDiffReviewControlStyles } from './mobile-diff-review-control-styles'
import { mobileDiffReviewLayoutStyles } from './mobile-diff-review-layout-styles'

export const mobileDiffReviewStyles = createThemedStyles(() => ({
  ...mobileDiffReviewLayoutStyles,
  ...mobileDiffReviewControlStyles
}))
