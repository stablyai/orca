# Orca mobile link taps — 2026-09-08

Implemented on `lqez/mobile-link-tap-fix`, based on `origin/main` at `81bd9129282d0f3c26504517240a0123a26f7292`. Two independent input failures were reproduced and fixed. Ordinary web MarkdownPreview links already worked in the baseline; changing their URLs or renderer would not fix either failure.

## 1. Mobile streamed browser: the tap used the wrong coordinate units

The mobile browser's Mobile View requests Chromium mobile emulation. A page without a viewport meta tag produces a 980 CSS-pixel layout inside a 390 DIP frame: the actual `Page.screencastFrame` reported `pageScaleFactor = 0.3979591727256775`. Desktop View does not request mobile emulation and this case has scale 1.

`mapScreenToBrowserPoint` inverted letterboxing and local image zoom/pan, but returned frame DIP coordinates directly as CSS coordinates. Both the runtime's DOM hit test and CDP mouse input expect viewport CSS coordinates. The input therefore reached an unrelated part of the page, before URL handling could matter.

The real Chromium/CDP before/after test used the same rendered link and visual tap:

| Observation                        | Before             | After        |
| ---------------------------------- | ------------------ | ------------ |
| Visual frame point                 | (149.235, 148.837) | Same         |
| Browser input                      | (149, 149)         | (375, 374)   |
| Trusted pointer/mouse/click target | BODY               | `a#markdown` |
| `defaultPrevented`                 | false              | false        |
| Link navigation                    | No hash navigation | `#opened`    |

Full metadata, input coordinates and event sequence: [streamed-scale-events.json](streamed-scale-events.json). This was a hit-testing error, not a transparent overlay, stopped propagation or a Markdown URL error. The fixture records the event target on screen so the screenshots visibly distinguish the missed tap from activation.

The existing geometry now divides the mapped point and touch tolerance by the validated frame page scale. Missing, zero, negative and non-finite scale metadata retain the legacy scale-1 fallback. The remote web/desktop stream viewer also uses live scaled frame dimensions when its cached CSS viewport is stale, including after returning to scale 1. One shared scale reader supplies both clients.

Wheel movement deliberately retains its existing calculation. Real CDP testing showed that a wheel delta of 251 at page scale 0.398 scrolls 631 CSS pixels, whereas a delta of 100 scrolls about 251 CSS pixels: wheel deltas use visual units even though pointer positions use CSS units. The regression verifies that a 40-pixel wheel input moves the rendered page by 40 pixels at every tested page scale.

## 2. Web terminal: xterm suppresses the compatibility mouse click

The actual production xterm renderer, pointer gesture, link primer, HTTP/file routers and link action popover were mounted in the browser fixture. With the new touch installer disabled, an iPhone tap reaches `.xterm-screen`; xterm's document-level touch gesture handler cancels `touchstart` and `touchend`. The browser sends trusted pointer and touch events, but never synthesizes `mousedown`, `mouseup` or `click`. Orca's mouse-based link activation consequently does not run. Desktop mouse input on the same terminal does run it.

Evidence: [Chromium baseline](mobile-chromium-baseline-events.json), [WebKit baseline](mobile-webkit-baseline-events.json), and the initial [before](terminal-before.json)/[after](terminal-after.json) mobile-versus-desktop action probes. Capture/bubble records show the canceled touch event; the target remains the terminal screen throughout.

A terminal-scoped touch recognizer now activates the existing URL, file and OSC 8 link routing for one stationary, short, single-finger tap. The tap opens the same destination chooser as an ordinary desktop click; choosing System Browser opens a real browser destination. No mouse events are dispatched into the terminal or PTY. The existing pane cleanup owns the new listener disposal.

The recognizer rejects movement above 8 CSS pixels, a gesture returning after a drag, long presses above 400 ms, multiple fingers, existing/new selection, terminal scrollback movement, touch cancellation, window blur and disposed panes. It does not prevent touchstart or touchmove, so xterm keeps its scrolling behavior. Actual CDP swipes still move terminal scrollback.

## Representative validation

| Surface                                                              | Mobile Chromium                        | Mobile WebKit                                                    | Desktop Chromium                             |
| -------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| Terminal HTTP URL, README.md and OSC 8 label                         | First tap opens existing chooser       | Same                                                             | Existing click works                         |
| Terminal System Browser action                                       | Real popup destination, focus restored | Same                                                             | Same                                         |
| Actual MarkdownPreview body and automatic links                      | Native single tap navigates            | Same                                                             | Same                                         |
| Actual MarkdownPreview internal anchor                               | Scrolls to heading                     | Same                                                             | Same                                         |
| Card link and external Button                                        | Native single tap navigates            | Same                                                             | Same                                         |
| Terminal swipe, drag-return, long press, selection, pinch and cancel | CDP guard/scroll tests pass            | Tap baseline/activation covered; gesture sequences not exercised | Pointer unit tests and click regression pass |

The streamed-browser suite uses real `Page.screencastFrame` metadata and images, production client geometry, the existing runtime DOM hit-test expression, and trusted CDP pointer dispatch. It covers ordinary anchor/Markdown-style HTML output, automatic-link HTML, internal and external links, cards, buttons, and an iframe link after scrolling, in mobile layout scale 0.398, responsive scale 1, page zoom 1.25, and Desktop View scale 1. Evidence: [mobile](streamed-mobile-matrix.json), [responsive](streamed-responsive-matrix.json), [zoomed](streamed-zoomed-matrix.json), [desktop](streamed-desktop-matrix.json).

The mobile unit suite additionally inverts local image zoom/pan at page scales 0.398, 1 and 1.25, rejects letterbox taps, and checks the CSS touch tolerance and legacy metadata fallback. Page scroll offsets are intentionally not added to viewport-relative input coordinates.

Accessibility checks measure every existing terminal chooser button at at least 24×24 CSS pixels after its opening animation, and verify Escape/action completion restore the terminal input focus. No controls, tokens, shortcut rules or focus policy were redesigned. This does not certify third-party pages' own target sizes or a physical-device screen-reader flow.

## Checks and reproduction

All tests/builds ran with `ORCA_BACKGROUND_LAUNCH=1`; browser instances were headless. No Electron/native window was shown or activated.

| Check                                                            | Result                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm tc` (node, CLI, renderer projects)                         | Passed                                               |
| `pnpm exec tsc --project tests/web/tsconfig.json`                | Passed                                               |
| `pnpm --dir mobile typecheck`                                    | Passed                                               |
| `pnpm check:code-quality:changed`                                | Passed, no new lint/type-aware/React Doctor findings |
| Mobile changed-file oxlint                                       | Passed                                               |
| Existing/new terminal and Markdown routing tests                 | 20 files / 210 tests passed                          |
| Stream input model, codec, runtime mouse and screencast tests    | 4 files / 48 tests passed                            |
| `pnpm --dir mobile test src/browser`                             | 7 files / 33 tests passed                            |
| `pnpm test:web:mobile-links`                                     | 18 passed, 5 intentional project skips               |
| Follow-up streamed-browser tests including actual wheel movement | 5 passed                                             |
| `pnpm build:web`                                                 | Passed, including web output verification            |
| `pnpm build:electron-vite`                                       | Passed                                               |
| `git diff --check`                                               | Passed                                               |

The initial setup hook failed because `pnpm` was unavailable. Corepack's pnpm shim was also incompatible with this installation, so commands used the repository's pinned version through `npx --yes pnpm@12.0.0`. Root and mobile dependencies were installed with `--frozen-lockfile`; no dependency or lockfile changes are included. Concurrent pnpm mobile invocations later raced its automatic relinking of a local package; the final mobile typecheck and lint used the already installed `mobile/node_modules/.bin` tools directly and passed. Build logs contain existing bundle-size warnings.

Run the browser regression with:

```sh
ORCA_BACKGROUND_LAUNCH=1 npx --yes pnpm@12.0.0 exec playwright install chromium webkit
ORCA_BACKGROUND_LAUNCH=1 npx --yes pnpm@12.0.0 run test:web:mobile-links
```

The dedicated config is `tests/mobile-link-tap.playwright.config.ts`. It starts the local Vite fixture, uses iPhone 13 Chromium/WebKit and desktop Chromium projects, and writes JSON attachments to `tests/test-results/mobile-link-tap-results.json`. The terminal baseline is directly reproducible at the fixture URL with `?withoutTouchLinks`; the streamed baseline explicitly omits the page-scale correction for the first input on the same live frame. Screenshots are attached to the PR, not committed, following the repository PR template. Local copies are `scaled-source-before.png`, `scaled-source-after.png`, `mobile-chromium-baseline.png`, `mobile-chromium-link-row-0.png`, and the corresponding WebKit/desktop captures beside this report. Validation command logs also remain beside this report as ignored `.log` files.

## Compatibility and remaining limits

- No RPC shape, stream opcode, published metadata or protocol version changes. Clients consume the existing optional scale metadata and preserve the fallback for older hosts. Server and remote execution ownership remain unchanged.
- Terminal taps reuse the existing current pane CWD, runtime, SSH owner and browser destination getters. Existing remote/file routing tests pass; no local-only or git-worktree-only assumption was added.
- Tests ran on macOS with real headless Chromium and WebKit, not a physical iPhone, an iOS simulator or a live paired SSH server. The fixture uses actual renderer components with seeded workspace state and a filesystem-existence boundary stub; it does not launch the full Orca shell or exercise the native mobile app's image responder on a device.
- No separate baseline failure was found in ordinary web MarkdownPreview. Its passing behavior is retained as a control, including [the initial WebKit event probe](webkit-preview.jsonl). The user's exact phone/session and Request Desktop Site sequence were unavailable; the code's Mobile View/Desktop View stream emulation paths were compared instead.
- The requested `$electron` skill was unavailable in installed skills and the Orca skill catalog. Validation therefore used actual mobile web renderers and Playwright/CDP without launching Electron. Native packaging and OS-focus/device tests were not run.
- The terminal's OSC 8 label lookup uses guarded xterm internals, following the existing mobile WebView approach. A future xterm internal change can require adjusting that lookup; URL/file paths continue to use existing public buffer hit tests.
