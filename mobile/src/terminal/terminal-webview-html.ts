import { TERMINAL_DOCUMENT_SCRIPT } from './terminal-webview-document-script.generated'
import { TERMINAL_HTML_DOCUMENT_CLOSE } from './terminal-webview-html/document-close'
import { TERMINAL_HTML_DOCUMENT_SHELL } from './terminal-webview-html/document-shell'

export { MOBILE_TERMINAL_CARET_OPTIONS } from './terminal-webview-html/theme'
// Re-export markup/style on both platforms so the web sibling can omit native script strings.
export { TERMINAL_DOCUMENT_MARKUP } from './terminal-webview-html/document-markup'
export {
  TERMINAL_DOCUMENT_ELEMENT_STYLE,
  TERMINAL_DOCUMENT_STYLE
} from './terminal-webview-html/document-style'

// Generate native script from the same modules embedded pages import.
export const XTERM_HTML = [
  TERMINAL_HTML_DOCUMENT_SHELL,
  TERMINAL_DOCUMENT_SCRIPT,
  TERMINAL_HTML_DOCUMENT_CLOSE
].join('')

// Seed scale/visibility in page source before document startup can read them.
export function xtermWebViewSource(start: { textScale: number; shown: boolean }) {
  const startValues =
    `window.__orcaTerminalTextScale = ${JSON.stringify(start.textScale)};\n` +
    `window.__orcaTerminalShown = ${JSON.stringify(start.shown)};\n`
  return {
    html: [
      TERMINAL_HTML_DOCUMENT_SHELL,
      startValues,
      TERMINAL_DOCUMENT_SCRIPT,
      TERMINAL_HTML_DOCUMENT_CLOSE
    ].join('')
  }
}
