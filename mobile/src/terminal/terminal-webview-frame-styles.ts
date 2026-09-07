import { StyleSheet } from 'react-native'
import { colors } from '../theme/mobile-theme'

export const TERMINAL_WEBVIEW_FRAME_STYLES = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.terminalBg
  },
  webview: {
    flex: 1,
    backgroundColor: colors.terminalBg
  },
  // Why: the surface stays themed (container bg) while the document cannot paint yet;
  // opacity keeps layout and the WKWebView alive, unlike unmounting (#17304).
  webviewHidden: {
    opacity: 0
  }
})
