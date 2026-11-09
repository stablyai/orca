import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const TERMINAL_WEBVIEW_FRAME_STYLES = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.terminalBg
  },
  webview: {
    flex: 1,
    backgroundColor: colors.terminalBg
  }
}))
