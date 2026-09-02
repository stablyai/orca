import { colors } from '../../theme/mobile-theme'
import { XTERM_ENGINE_CSS, XTERM_ENGINE_JS } from '../terminal-webview-engine.generated'

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
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    background: ${colors.terminalBg};
    overflow: hidden;
    width: 100%;
    height: 100%;
  }
  #terminal-container {
    overflow: hidden;
    position: relative;
    width: 100%;
    height: 100%;
  }
  #terminal-surface {
    transform-origin: top left;
    display: inline-block;
  }
  .xterm { -webkit-user-select: none; user-select: none; font-variant-emoji: text; }
  .xterm .xterm-viewport {
    overflow-y: hidden !important;
    scrollbar-width: none !important;
    -ms-overflow-style: none;
  }
  .xterm .xterm-viewport::-webkit-scrollbar {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
    background: transparent !important;
  }
  .xterm .xterm-scrollable-element > .xterm-scrollbar,
  .xterm .xterm-scrollbar {
    display: none !important;
    width: 0 !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
  #scroll-indicator {
    position: fixed;
    top: 4px;
    right: 3px;
    bottom: 4px;
    width: 3px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 120ms linear;
    z-index: 7;
  }
  #scroll-indicator.visible { opacity: 0.72; }
  #scroll-thumb {
    position: absolute;
    top: 0;
    right: 0;
    width: 3px;
    min-height: 24px;
    border-radius: 999px;
    background: ${colors.textSecondary};
    will-change: transform, height;
  }
  /* Why: selection overlay sits in unscaled viewport coords, above the
     transformed surface, so handle hit areas and Copy menu positions
     don't depend on getTotalScale() for their on-screen size. */
  #selection-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    pointer-events: none;
    z-index: 10;
    display: none;
  }
  #selection-overlay.active { display: block; }
  .sel-handle {
    position: absolute;
    width: 44px; height: 44px;
    margin-left: -22px; margin-top: -22px;
    pointer-events: auto;
    background: transparent;
  }
  .sel-handle::before {
    content: '';
    position: absolute;
    left: 50%; top: 22px;
    transform: translateX(-50%);
    width: 14px; height: 14px;
    background: #7aa2f7;
    border-radius: 50%;
    border: 2px solid #c0caf5;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  }
  .sel-handle.start::before { top: 8px; }
  .sel-handle.start::after {
    content: '';
    position: absolute;
    left: 50%; top: 22px;
    transform: translateX(-50%);
    width: 2px; height: 16px;
    background: #7aa2f7;
  }
  .sel-handle.end::before { top: 22px; }
  .sel-handle.end::after {
    content: '';
    position: absolute;
    left: 50%; top: 6px;
    transform: translateX(-50%);
    width: 2px; height: 16px;
    background: #7aa2f7;
  }
  #sel-menu {
    position: absolute;
    pointer-events: auto;
    background: #2a2f4a;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    display: flex;
    overflow: hidden;
    transform: translateY(-100%);
    margin-top: -12px;
    user-select: none;
    -webkit-user-select: none;
  }
  #sel-menu button {
    background: transparent;
    border: none;
    color: #c0caf5;
    font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 10px 16px;
    cursor: pointer;
  }
  #sel-menu button:active { background: #414868; }
  #sel-menu button + button { border-left: 1px solid #414868; }
</style>
</head>
<body>
<div id="terminal-container">
  <div id="terminal-surface"></div>
</div>
<div id="scroll-indicator"><div id="scroll-thumb"></div></div>
<div id="selection-overlay">
  <div id="sel-handle-start" class="sel-handle start"></div>
  <div id="sel-handle-end" class="sel-handle end"></div>
  <div id="sel-menu">
    <button id="sel-menu-copy">Copy</button>
    <button id="sel-menu-all">Select All</button>
  </div>
</div>
<script>${XTERM_ENGINE_JS}</script>
<script>
(function() {
  var surface = document.getElementById('terminal-surface');
  var ESC = String.fromCharCode(27);
  var C1_CSI = String.fromCharCode(155);
  var CLAUDE_STATUS_DOT = String.fromCharCode(0x23fa);
  var TEXT_PRESENTATION_SELECTOR = String.fromCharCode(0xfe0e);
  var EMOJI_PRESENTATION_SELECTOR = String.fromCharCode(0xfe0f);
  var CLAUDE_STATUS_DOT_PATTERN = new RegExp(CLAUDE_STATUS_DOT + '[' + TEXT_PRESENTATION_SELECTOR + EMOJI_PRESENTATION_SELECTOR + ']*', 'g');
  var statusDotPendingSelector = false;
`
