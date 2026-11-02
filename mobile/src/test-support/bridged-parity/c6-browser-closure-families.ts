import type { PageClosurePins } from './page-closure'

/**
 * The goldens recorded at a call site inside the browser pane's closure, and what each one did at
 * the bridge.
 *
 * A half with no composed `c6-page-closure.ts` beside it, unlike every series before this one. A
 * composed table is pinned against a route and C6 has none: the browser is a pane of the session
 * screen, mounted from `MobileSessionActiveContent`, so C7 is what registers a route that reaches
 * it. C7 spreads this table beside C1's. The derivation census does not wait for that route: it reads
 * the pane's closure from the module itself, in `mobile-web-app-page-closure-families.test.mjs`.
 *
 * Derived from the value-import closure of `MobileBrowserPane` with `.web.*` resolution applied,
 * measured through the builder's own options: 48 local modules on its own, and 34 beyond the shared
 * layout, of which 30 are under `src/browser` and four are reached through its web siblings —
 * `bridge-envelope.ts`, `bridge-error-capture.ts`, `browser-screencast-protocol.ts` and
 * `rpc-response-shape.ts`, which the frame budget and the binary decoder pull in. The corpus records
 * the pane at exactly two sites, `use-mobile-browser-request.ts` and
 * `use-mobile-browser-commands.ts`, and the pane alone reaches all four families: the shared layout
 * contributes none of them.
 *
 * **What 15 certified does not say.** `browser.screencast` has no golden at all. The corpus records
 * the thirteen page commands and never the stream, so this pin certifies the input path — the taps,
 * the wheel, the keyboard and the dialogs — byte for byte, and says nothing whatever about the
 * frame path that C6.1 through C6.4 built. That is what the device proof has to carry.
 *
 * Every verdict is what C2's rule predicts: a `matrix-` golden is `result-absent-settlement`, for
 * the reason the parity suite's own docstring gives, and every other replays byte-identically. All
 * fifteen were measured per family with vitest `-t` over the full 789-golden corpus, with C1's 103
 * pins reproduced golden-for-golden as the control for the harness that measured them.
 */
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
