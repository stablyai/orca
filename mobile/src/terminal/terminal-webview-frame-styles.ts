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
  // Why: the container shares the terminal background, so the hidden interval reads as flat
  // theme; opacity keeps layout and the WKWebView alive, unlike unmounting (#17304).
  webviewHidden: {
    opacity: 0
  }
})
