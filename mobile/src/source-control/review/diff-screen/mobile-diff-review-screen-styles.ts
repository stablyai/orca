import { themedStyles } from '../../../theme/themed-styles'
import { mobileDiffReviewControlStylesSheet } from './mobile-diff-review-control-styles'
import { mobileDiffReviewLayoutStylesSheet } from './mobile-diff-review-layout-styles'

export const mobileDiffReviewStylesSheet = themedStyles((_colors, scheme) => ({
  ...mobileDiffReviewLayoutStylesSheet.resolve(scheme),
  ...mobileDiffReviewControlStylesSheet.resolve(scheme)
}))
