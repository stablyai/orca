import { TERMINAL_DOCUMENT_MARKUP } from './document-markup'
import { TERMINAL_DOCUMENT_STYLE } from './document-style'
import { XTERM_ENGINE_CSS } from '../terminal-webview-engine-css.generated'
import { XTERM_ENGINE_JS } from '../terminal-webview-engine.generated'

export const TERMINAL_HTML_DOCUMENT_SHELL = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<script>
window.__engineErrors = [];
window.onerror = function(msg) {
  // Why: a degraded engine can throw per frame; cap so the capture buffer
  // and downstream reporting stay bounded for the document's lifetime.
  if (window.__engineErrors.length < 20) window.__engineErrors.push(String(msg));
};
</script>
<style>${XTERM_ENGINE_CSS}</style>
<style>
${TERMINAL_DOCUMENT_STYLE}
</style>
</head>
<body>
${TERMINAL_DOCUMENT_MARKUP}
<script>${XTERM_ENGINE_JS}</script>
<script>
`
