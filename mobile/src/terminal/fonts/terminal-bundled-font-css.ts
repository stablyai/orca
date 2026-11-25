import { TERMINAL_BUNDLED_FONT_CSS } from '../document/terminal-bundled-font-css.generated'
import { isTerminalBundledFont, type TerminalFontId } from '../preferences/terminal-font-style'

// Kept apart from the native terminal HTML so the settings preview doesn't load the whole engine.
/** The inlined @font-face rules for a bundled font, or undefined for a system font. */
export function terminalBundledFontCss(font: TerminalFontId): string | undefined {
  return isTerminalBundledFont(font) ? TERMINAL_BUNDLED_FONT_CSS[font] : undefined
}
