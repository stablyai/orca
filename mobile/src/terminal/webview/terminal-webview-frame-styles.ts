import { StyleSheet } from 'react-native'
import { paletteForScheme } from '../../theme/mobile-theme'

const TERMINAL_BG = paletteForScheme('dark').terminalBg

export const TERMINAL_WEBVIEW_FRAME_STYLES = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: TERMINAL_BG
  },
  webview: {
    flex: 1,
    backgroundColor: TERMINAL_BG
  }
})
