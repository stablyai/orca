import { createThemedStyles } from '../theme/mobile-themed-styles'
import { mobileSessionCommandInputStyles } from './mobile-session-command-input-styles'
import { mobileSessionFrameStyles } from './mobile-session-frame-styles'
import { mobileSessionReaderStyles } from './mobile-session-reader-styles'
import { mobileSessionReviewCommentStyles } from './mobile-session-review-comment-styles'

export const styles = createThemedStyles(() => ({
  ...mobileSessionFrameStyles,
  ...mobileSessionReaderStyles,
  ...mobileSessionReviewCommentStyles,
  ...mobileSessionCommandInputStyles
}))
