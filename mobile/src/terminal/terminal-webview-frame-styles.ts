import { StyleSheet } from 'react-native'
import { darkColors } from '../theme/mobile-theme'

export const TERMINAL_WEBVIEW_FRAME_STYLES = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: darkColors.terminalBg
  },
  webview: {
    flex: 1,
    backgroundColor: darkColors.terminalBg
  }
})
