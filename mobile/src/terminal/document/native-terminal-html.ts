import { TERMINAL_DOCUMENT_SCRIPT } from './terminal-webview-document-script.generated'
import { TERMINAL_HTML_DOCUMENT_CLOSE } from '../terminal-webview-html/document-close'
import { TERMINAL_HTML_DOCUMENT_SHELL } from '../terminal-webview-html/document-shell'

import '../terminal-webview-html/theme'

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
