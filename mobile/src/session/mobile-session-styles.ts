import { mobileSessionCommandInputStylesSheet } from '../terminal/session/input-controls/mobile-session-command-input-styles'
import { mobileSessionFrameStylesSheet } from './mobile-session-frame-styles'
import { mobileSessionReaderStylesSheet } from '../files/session-documents/mobile-session-reader-styles'
import { mobileSessionReviewCommentStylesSheet } from '../source-control/review/review-notes/mobile-session-review-comment-styles'
import { themedStyles } from '../theme/themed-styles'

export const stylesSheet = themedStyles((_colors, scheme) => ({
  ...mobileSessionFrameStylesSheet.resolve(scheme),
  ...mobileSessionReaderStylesSheet.resolve(scheme),
  ...mobileSessionReviewCommentStylesSheet.resolve(scheme),
  ...mobileSessionCommandInputStylesSheet.resolve(scheme)
}))
