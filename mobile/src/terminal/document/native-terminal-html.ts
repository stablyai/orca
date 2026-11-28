import { TERMINAL_DOCUMENT_SCRIPT } from './terminal-webview-document-script.generated'
import { TERMINAL_HTML_DOCUMENT_CLOSE } from '../terminal-webview-html/document-close'
import { TERMINAL_HTML_DOCUMENT_SHELL } from '../terminal-webview-html/document-shell'
import type { TerminalFontStyle } from '../preferences/terminal-font-style'
import { terminalBundledFontCss } from '../fonts/terminal-bundled-font-css'

// Generate native script from the same modules embedded pages import.
export const XTERM_HTML = [
  TERMINAL_HTML_DOCUMENT_SHELL,
  TERMINAL_DOCUMENT_SCRIPT,
  TERMINAL_HTML_DOCUMENT_CLOSE
].join('')

// Seed scale/style/visibility in page source before document startup can read them; inline only the picked font.
export function xtermWebViewSource(start: {
  textScale: number
  fontStyle: TerminalFontStyle
  shown: boolean
}) {
  const startValues =
    `window.__orcaTerminalTextScale = ${JSON.stringify(start.textScale)};\n` +
    `window.__orcaTerminalFontStyle = ${JSON.stringify(start.fontStyle)};\n` +
    `window.__orcaTerminalShown = ${JSON.stringify(start.shown)};\n`
  const fontCss = terminalBundledFontCss(start.fontStyle.font)
  const shell = fontCss
    ? TERMINAL_HTML_DOCUMENT_SHELL.replace(
        '</head>',
        () => `<style data-orca-terminal-font="${start.fontStyle.font}">${fontCss}</style>\n</head>`
      )
    : TERMINAL_HTML_DOCUMENT_SHELL
  return {
    html: [shell, startValues, TERMINAL_DOCUMENT_SCRIPT, TERMINAL_HTML_DOCUMENT_CLOSE].join('')
  }
}
