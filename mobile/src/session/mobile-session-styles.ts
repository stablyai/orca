import { mobileSessionCommandInputStyles } from './mobile-session-command-input-styles'
import { mobileSessionFrameStyles } from './mobile-session-frame-styles'
import { mobileSessionReaderStyles } from './mobile-session-reader-styles'
import { mobileSessionReviewCommentStyles } from './mobile-session-review-comment-styles'
import { themedStyles } from '../theme/themed-styles'

// Spread per scheme: spreading the themed parts once would freeze the load-time palette.
export const styles = themedStyles(() => ({
  ...mobileSessionFrameStyles,
  ...mobileSessionReaderStyles,
  ...mobileSessionReviewCommentStyles,
  ...mobileSessionCommandInputStyles
}))
