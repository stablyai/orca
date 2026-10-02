/**
 * What the page needs from the terminal's HTML, which is the markup and the stylesheet and
 * nothing else.
 *
 * The native file composes a whole document: the shell, the 612 KiB engine string and the
 * generated script. On the page none of those three can be used. The shell's CSP is
 * `script-src 'self'` with `frame-src 'none'`, so there is no nested document to load and no
 * inline script to run; the engine arrives as an import instead, and the script's modules are
 * imported directly. Exporting the document string here would put all of it in the page's closure
 * to be dropped — `mobile-web-terminal-engine-closure.test.mjs` is the fence that says it is not.
 *
 * The stylesheet is the element half only. The document-level rules — `*`, `html`, `body` — are
 * the WebView's alone: on the page they would restyle the whole application and go on doing it
 * after the terminal is gone. `scopeStyleToHost` is what holds the rest under the host element.
 *
 * `MOBILE_TERMINAL_CARET_OPTIONS` is re-exported because both hosts build the same caret.
 */
export { MOBILE_TERMINAL_CARET_OPTIONS } from './terminal-webview-html/theme'
export { TERMINAL_DOCUMENT_MARKUP } from './terminal-webview-html/document-markup'
export { TERMINAL_DOCUMENT_ELEMENT_STYLE } from './terminal-webview-html/document-style'
