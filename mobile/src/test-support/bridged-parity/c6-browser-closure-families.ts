import type { PageClosurePins } from './page-closure'

// The browser pane has no standalone route; C7 composes these pins with C1 while derivation starts at the pane module.
// Recordings cover browser command input only; no screencast stream is recorded, so frame-path validation needs separate evidence.
export const C6_BROWSER_CLOSURE_FAMILIES: PageClosurePins = {
  'browser.dialog': {
    'browser-dialog-accepted': 'identical',
    'browser-dialog-dismissed': 'identical',
    'matrix-browser.dialog-browser.dialogaccept-1': 'result-absent-settlement'
  },
  'browser.keyboard': {
    'browser-keyboard-input': 'identical',
    'matrix-browser.keyboard-browser.keyboardinserttext-1': 'result-absent-settlement',
    'matrix-browser.keyboard-browser.keypress-1': 'result-absent-settlement'
  },
  'browser.pointer-click': {
    'browser-pointer-click-accepted': 'identical',
    'browser-pointer-click-fallback': 'identical',
    'matrix-browser.pointer-click-browser.mouseclick-1': 'result-absent-settlement',
    'matrix-browser.pointer-click-browser.mousedown-1': 'result-absent-settlement',
    'matrix-browser.pointer-click-browser.mousemove-1': 'result-absent-settlement',
    'matrix-browser.pointer-click-browser.mouseup-1': 'result-absent-settlement'
  },
  'browser.wheel': {
    'browser-wheel-scrolled': 'identical',
    'matrix-browser.wheel-browser.mousemove-1': 'result-absent-settlement',
    'matrix-browser.wheel-browser.mousewheel-1': 'result-absent-settlement'
  }
}
