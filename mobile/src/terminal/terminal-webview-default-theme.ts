import type { RuntimeMobileTerminalTheme } from '../../../src/shared/runtime-types'
import { colors } from '../theme/mobile-theme'

export const DEFAULT_TERMINAL_WEBVIEW_THEME: RuntimeMobileTerminalTheme['theme'] = {
  background: colors.terminalBg,
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  cursorAccent: colors.terminalBg,
  selectionBackground: '#33467c',
  selectionForeground: '#c0caf5',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5'
}
