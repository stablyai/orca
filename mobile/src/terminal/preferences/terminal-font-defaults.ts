import { Dimensions } from 'react-native'
import { getResponsiveLayoutMetrics } from '../../layout/responsive-layout-metrics'
import {
  DEFAULT_TERMINAL_FONT_STYLE,
  TABLET_TERMINAL_FONT_STYLE,
  type TerminalFontStyle
} from './terminal-font-style'
import { terminalTextScaleForPx } from './terminal-text-scales'

export type TerminalFontDefaults = { textScale: number; fontStyle: TerminalFontStyle }

// The screen, not the window: an iPad in a narrow split is still an iPad. Each device stores its own values.
export function terminalFontDefaults(): TerminalFontDefaults {
  const { width, height } = Dimensions.get('screen')
  return getResponsiveLayoutMetrics(width, height).isTabletLayout
    ? { textScale: terminalTextScaleForPx(15), fontStyle: TABLET_TERMINAL_FONT_STYLE }
    : { textScale: terminalTextScaleForPx(13), fontStyle: DEFAULT_TERMINAL_FONT_STYLE }
}
