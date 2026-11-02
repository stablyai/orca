import { themedStyles } from '../theme/themed-styles'
import { mobileDiffReviewControlStyles } from './mobile-diff-review-control-styles'
import { mobileDiffReviewLayoutStyles } from './mobile-diff-review-layout-styles'

export const mobileDiffReviewStyles = themedStyles(() => ({
  ...mobileDiffReviewLayoutStyles,
  ...mobileDiffReviewControlStyles
}))
