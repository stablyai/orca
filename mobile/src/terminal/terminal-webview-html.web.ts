// Export only markup and element styles: CSP disallows nested/inline documents, and web imports the engine/modules directly.
// Keep native script strings outside the web closure and scope element styles to the terminal host.
export { MOBILE_TERMINAL_CARET_OPTIONS } from './terminal-webview-html/theme'
export { TERMINAL_DOCUMENT_MARKUP } from './terminal-webview-html/document-markup'
export { TERMINAL_DOCUMENT_ELEMENT_STYLE } from './terminal-webview-html/document-style'
