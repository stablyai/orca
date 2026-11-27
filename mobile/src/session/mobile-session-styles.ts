import { mobileSessionCommandInputStyles } from '../terminal/session/input-controls/mobile-session-command-input-styles'
import { mobileSessionFrameStyles } from './mobile-session-frame-styles'
import { mobileSessionReaderStyles } from '../files/session-documents/mobile-session-reader-styles'
import { mobileSessionReviewCommentStyles } from '../source-control/review/review-notes/mobile-session-review-comment-styles'
import { themedStyles } from '../theme/themed-styles'

// Spread per scheme: spreading the themed parts once would freeze the load-time palette.
export const styles = themedStyles(() => ({
  ...mobileSessionFrameStyles,
  ...mobileSessionReaderStyles,
  ...mobileSessionReviewCommentStyles,
  ...mobileSessionCommandInputStyles
}))
