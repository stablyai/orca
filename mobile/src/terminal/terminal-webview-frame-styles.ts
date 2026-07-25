import { StyleSheet } from 'react-native'
import type { ThemeColors } from '../theme/mobile-theme'

// RN frame fallback only. TerminalWebView overlays frameOverride from the resolved
// terminal palette once it arrives — so light-mode apps no longer flash a dark
// #1a1b26 block before the palette resolves (lightColors.terminalBg is #ffffff).
export const createTerminalWebViewFrameStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.terminalBg
    },
    webview: {
      flex: 1,
      backgroundColor: colors.terminalBg
    }
  })
