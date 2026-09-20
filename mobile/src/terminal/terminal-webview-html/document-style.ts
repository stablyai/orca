import { colors } from '../../theme/mobile-theme'

/**
 * The rules that style the document itself, which only the WebView's document may carry.
 *
 * Inside the WebView this is the terminal's own page and these say so. On the page the document
 * is a guest in a React Native Web application, and the same three selectors would set that
 * application's background, its overflow and every element's box model — and keep doing it after
 * the terminal is gone. So the page never injects them; `document-style-scoping.ts` is what
 * separates them from the rules below, and it recognises them by their selectors rather than by
 * this split, so a fourth one added here is still caught there.
 */
export const TERMINAL_DOCUMENT_ROOT_STYLE = `  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    background: ${colors.terminalBg};
    overflow: hidden;
    width: 100%;
    height: 100%;
  }`

/**
 * The terminal's own elements, beside xterm's sheet.
 *
 * Split out of the document shell because the page needs exactly this and must not reach the
 * engine string the shell also splices in. The rules are addressed at the ids and classes
 * `document-markup.ts` declares, which is the other half of the same pair; the page holds every
 * one of them under its host element rather than letting them loose in the application.
 */
export const TERMINAL_DOCUMENT_ELEMENT_STYLE = `  #terminal-container {
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
  #sel-menu button + button { border-left: 1px solid #414868; }`

/**
 * Both halves, in the order the WebView's `<head>` has always carried them.
 *
 * The concatenation is what the document shell splices in, so the emitted document does not move
 * for this split — the byte golden says whether that held.
 */
export const TERMINAL_DOCUMENT_STYLE = `${TERMINAL_DOCUMENT_ROOT_STYLE}
${TERMINAL_DOCUMENT_ELEMENT_STYLE}`
