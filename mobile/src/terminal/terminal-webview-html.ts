import { TERMINAL_DOCUMENT_SCRIPT } from './terminal-webview-document-script.generated'
import { TERMINAL_HTML_DOCUMENT_CLOSE } from './terminal-webview-html/document-close'
import { TERMINAL_HTML_DOCUMENT_SHELL } from './terminal-webview-html/document-shell'

export { MOBILE_TERMINAL_CARET_OPTIONS } from './terminal-webview-html/theme'
// Re-exported so the page's `.web.ts` sibling can answer the same names without the document
// string: whatever imports this gets markup and style on both platforms. The page takes the
// element half only — the document-level rules are this document's alone.
export { TERMINAL_DOCUMENT_MARKUP } from './terminal-webview-html/document-markup'
export {
  TERMINAL_DOCUMENT_ELEMENT_STYLE,
  TERMINAL_DOCUMENT_STYLE
} from './terminal-webview-html/document-style'

// Why: the script the WebView runs is generated from `src/terminal/document/`, the same modules the
// web page imports, so there is one source for both. The shell and the close are still text: they
// are markup, not program.
export const XTERM_HTML = [
  TERMINAL_HTML_DOCUMENT_SHELL,
  TERMINAL_DOCUMENT_SCRIPT,
  TERMINAL_HTML_DOCUMENT_CLOSE
].join('')

/**
 * The WebView's document, starting as its view mounted: at this text scale, and whether it was
 * shown. Written into the page ahead of the document script, which reads them as it starts.
 */
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
