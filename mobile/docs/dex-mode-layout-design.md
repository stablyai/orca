# Samsung DeX / desktop-mode layout fix — design

Status: design only (no code changes). Scope: `mobile/` only.
Target: Orca mobile Android (Expo SDK 55, React Native 0.83, expo-router, `newArchEnabled: true`).

Samsung DeX (and Android 15+ desktop windowing) changes five things at once that a
phone build never sees together: a **freeform, user-resizable window** (resized
without Activity recreation only if the manifest allows it), a **density (DPI)
change** when the display switches, **`smallestScreenWidthDp` crossings** as the
window is dragged, **no soft keyboard** (physical keyboard + mouse), and a window
whose size is *not* the display size. Almost every layout primitive in the app
assumes the opposite of at least one of those.

All line numbers below refer to the tree at the time of writing.

---

## 1. Symptom model

The report is "screen renders broken / garbled". Nobody has attached a
screenshot, so the design covers every symptom class that the code can
produce. Each class maps to one or more root causes in §2; the fix in §3–§4
addresses all of them.

| # | Symptom class (what the user sees) | Root causes |
|---|---|---|
| S1 | App "restarts": jumps back to the home route, splash flashes, terminals reconnect when DeX is entered/exited, a monitor is plugged in, or the window is dragged past a size breakpoint | R1 (Activity recreation: `density` / `smallestScreenSize` not in `configChanges`), R2 (no Samsung keep-alive metadata) |
| S2 | Terminal is a narrow phone-width strip inside a wide window, or text is cut off / overlaps / wraps at the old width; PTY columns don't follow the window | R5 (WebView measure uses stale `window.innerWidth`), R6 (refit only keyed off height + RN width, 150 ms debounce races the WebView re-layout), R7 (`applyTextScale` resizes xterm itself to `innerWidth`) |
| S3 | Drawers/sheets wider or taller than the window, centered content off-center, sidebar/dock decisions wrong for the window size, onboarding pages mis-paged | R3 (`useWindowDimensions` reports display size, not the freeform window, on Android) |
| S4 | Blurry, doubled or smeared glyphs after moving the window to another display / toggling DeX; canvas and DOM layers disagree | R4 (DPR change not observed by the fit pipeline; WebGL canvas scaled by CSS `scale()`) |
| S5 | With a hardware keyboard: `Esc` kicks the user out of the session; arrow/ctrl keys dead; caret focus flickers; input bar parks above an empty band reserved for a keyboard that never opens | R8 (`hardwareBackPress` == Esc), R9 (focus helper assumes `keyboardHeight==0` means "IME dismissed"), R10 (IME-height lift is the only avoidance path) |
| S6 | App opens in a fixed phone-sized window that can't be resized, or rotates/relayouts oddly when resized | R11 (`android:screenOrientation="fullUser"` set unconditionally by the rotation-lock plugin; no `resizeableActivity`) |
| S7 | Extra top padding or content under a title bar; bottom gap | R12 (edge-to-edge + safe-area assumptions; insets change per window) |
| S8 | Phone-sized DeX window gets tablet layout (sidebar + dock) and everything is squished, or a tablet-sized window stays in phone layout | R3, R13 (breakpoints only look at width/height, not at density or window class) |

---

## 2. Root-cause analysis (with evidence)

### R1 — Activity recreation on density / smallest-width changes (primary)

- `mobile/app.json` has no `expo-build-properties` Android manifest overrides
  beyond `usesCleartextTraffic` (`app.json:104-113`) and no `android.manifest`
  plugin. The only manifest plugin is `plugins/android-respect-rotation-lock.js`,
  which touches exactly one attribute (`android:screenOrientation`, lines 8 and
  13).
- The Expo SDK 55 bare template emits
  `android:configChanges="keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode"`
  on `MainActivity` (verify after prebuild in
  `android/app/src/main/AndroidManifest.xml`). **`density` and
  `smallestScreenSize` are absent.** Entering/leaving DeX changes density;
  dragging a freeform window across 600 dp / 720 dp width crosses
  `smallestScreenWidthDp`. Either change **destroys and recreates
  `MainActivity`**.
- Under RN 0.83 bridgeless, the `ReactHost` survives but the
  `ReactSurface`/root view is rebuilt, so the whole React tree remounts:
  `app/_layout.tsx` `RootLayout` re-runs (the splash hide hook at
  `_layout.tsx:156-158` fires again), expo-router's navigation container is
  recreated with no persisted state (user lands on `index`), `RpcClientProvider`
  remounts, and every `TerminalWebView` is recreated (xterm reload; all the
  `webReadyHandlesRef`/`initializedHandlesRef` bookkeeping in the session route,
  `[worktreeId].tsx:949-955`, starts from zero).
- This alone explains S1 and contributes to S2 (the first measure after a
  remount runs against a WebView that has not laid out yet).

### R2 — No Samsung DeX keep-alive metadata

Samsung documents two `<meta-data>` entries that suppress the DeX-specific
restarts (`com.samsung.android.keepalive.density` — don't restart on the
density change when DeX toggles; `com.samsung.android.multidisplay.keep_process_alive`
— keep the process when the app moves between phone and DeX displays). Neither
is emitted by any plugin in `mobile/plugins/` or `app.json`.

### R3 — `useWindowDimensions()` is the display, not the freeform window

On Android, RN's `DeviceInfoModule`/`DisplayMetricsHolder` derives `window`
metrics from the application context's display metrics (display size minus
system bars), **not** from the Activity's window bounds. In a freeform DeX
window those diverge (a 1920×1080 desktop vs. an 800×600 app window). Yoga
layout (`flex`, `onLayout`) is driven by the real root view size and is
correct; everything that reads `useWindowDimensions` is not. Consumers:

| File:line | What it decides from window dims |
|---|---|
| `src/layout/responsive-layout.ts:10-11` → `responsive-layout-metrics.ts:29-31` | `isWideLayout`, `isTabletLayout` (breakpoints 700/600) |
| `app/h/_layout.tsx:63, 91-94, 22-28` | sidebar show/hide, sidebar width clamp (`MIN_DETAIL_WIDTH = 320`) |
| `app/h/[hostId]/session/[worktreeId].tsx:757-766` | `canDockPanel` (combined with the correct `sessionContentRowWidth` from `onLayout`, `:4313-4316`) |
| `src/components/RightDrawer.tsx:90-93` → `right-drawer-panel-width.ts:9-22` | panel width = `windowWidth - 48` on narrow, `min(420, windowWidth)` on wide |
| `src/components/mounted-bottom-drawer.tsx:76-92` → `bottom-drawer-fill-height.ts:7-19` | fill-sheet height = `screenHeight - insets.top - 16 - keyboard` |
| `src/files/MobileFilePreviewScreen.tsx:49, 279-280` | image preview width/height |
| `app/mobile-onboarding.tsx:55, 141, 170, 177` | pager page width / slide translate |
| `src/terminal/terminal-viewport-refit.ts:206-221` | refit trigger on dims change (it will simply not fire on freeform resize; the frame-width/height triggers at `:234-243` and `:245-261` do) |
| `app/index.tsx:230`, `app/h/[hostId]/index.tsx:141, 1403`, `src/components/MobileDiffReviewScreenView.tsx:23-31` | content max-width / presentation mode |

In DeX a phone-width window on a 1080p display therefore gets
`isWideLayout = true`, a 1872 px-wide `RightDrawer`, a fill sheet taller than
the window, and a sidebar + docked panel crammed into ~800 px (S3, S8).

### R4 — Device-pixel-ratio changes are never observed

- `src/terminal/terminal-webview-html.ts` has a `resize` listener
  (`:1862-1872`) but no `matchMedia('(resolution: …dppx)')` / DPR listener.
  The WebGL addon (`@xterm/addon-webgl`, loaded in the engine) rasterises the
  glyph atlas at the DPR current at `term.open()`. Moving the window to a
  display with a different DPR (phone 2.6–3.0× → monitor 1.0–1.5×), or DeX
  toggling density, leaves the canvas at the wrong backing-store scale until
  something triggers a renderer resize.
- The fit pipeline then applies a CSS `scale()` on top
  (`updateTransform`, `:364-368`; `computeFitScale`, `:353-360`), which
  rasterises an already mis-scaled canvas → smeared/doubled glyphs (S4).
- On the RN side `PixelRatio.get()` is read inside a `useMemo` keyed only on
  `[layout, browserViewMode]` (`src/browser/MobileBrowserPane.tsx:355`), so the
  browser screencast request keeps the old DPR after a density change.

### R5 — `measureFitDimensions` uses `window.innerWidth`, only height comes from RN

- RN passes the exact frame **height** into the measure
  (`src/terminal/TerminalWebView.tsx:299-328`, message at `:319`), and the
  engine prefers it (`terminal-webview-html.ts:895-903`), but **width is always
  `window.innerWidth`** (`:895`). During a freeform drag the Android WebView
  re-lays out asynchronously; a measure issued 150 ms after the RN `onLayout`
  can read the *previous* `innerWidth`, compute the old column count, and
  push it to the PTY via `terminal.updateViewport` (`terminal-viewport-refit.ts:145-149`).
- `computeFitScale` (`:353-360`) and `clampPan` (`:409-424`) have the same
  dependency, so the CSS scale can be computed against a stale viewport.

### R6 — Refit trigger set is incomplete / racy for freeform resize

- `useTerminalViewportRefit` refits on: tab-strip toggle, window dims
  (`:206-221`), text scale, `terminalFrameWidth` (`:234-243`) and frame
  height (`:245-261`). The frame width/height path is the only one that fires
  in a freeform resize, and it is debounced 150 ms (`:86, :174`) from the *RN*
  layout, not from the WebView's own layout. There is no "WebView reported a
  new `innerWidth`" signal back to RN, so the race in R5 has no correction
  step until the next unrelated refit.
- The width/height effect deliberately skips height-only changes while the
  keyboard is visible (`:216`). With a hardware keyboard `keyboardVisible` is
  always false, so that guard is inert — fine — but there is also no
  coalescing for the 20–60 layout events/sec that a drag produces beyond the
  150 ms debounce; each commit triggers a server `updateViewport` + local
  `reflow` (`:155-160`).

### R7 — `applyTextScale` resizes xterm to `innerWidth/innerHeight`

`terminal-webview-html.ts:276-297` computes `cols = floor(innerWidth/cellW)`,
`rows = floor(innerHeight/cellH)` and calls `term.resize()` directly — while
the documented model (`:51`) is "init at desktop cols/rows and fit via CSS
scale". On a wide DeX window `innerWidth` is the *unscaled* WebView width, so a
text-size change produces a local grid that disagrees with the PTY grid until
the next server refit (contributes to S2 when the user changes text size in
DeX).

### R8 — `Esc` on a hardware keyboard is `hardwareBackPress`

`app/h/[hostId]/session/[worktreeId].tsx:2160-2165` installs a
`BackHandler` that always calls `requestLeaveSession()`. Android maps the
physical `Escape` key to `KEYCODE_ESCAPE`, which the framework delivers as a
back press when no view consumes it. `RightDrawer.tsx:114-122` does the same.
The live-input `TextInput` only sees `Escape` via `onKeyPress`
(`src/terminal/terminal-live-input.ts:36-38`) when it is focused *and* RN
reports the key; for many hardware-keyboard events RN Android's `onKeyPress`
only fires for a subset of keys (printable, Backspace, Enter), so arrows/F-keys/
Ctrl-combos never reach `handleLiveInputKeyPress`
(`src/terminal/use-terminal-live-input-commit.ts:150-175`) (S5).

### R9 — Focus helper treats `keyboardHeight === 0` as "IME dismissed"

`src/terminal/terminal-live-input.ts:231-248`: if `keyboardHeight <= 0` and the
input is focused, it blurs and schedules a refocus to "reopen the keyboard".
With a hardware keyboard attached there is never a `keyboardDidShow`
(`[worktreeId].tsx:2524-2541`), so `keyboardHeight` stays 0 and **every
terminal tap blurs + refocuses the input** — caret flicker, lost
composition, and on DeX the on-screen keyboard toggle may pop up (S5).

### R10 — Keyboard avoidance is IME-height only

`keyboardLift` (`[worktreeId].tsx:4206-4216`) and the pane `translateY`
(`src/session/TerminalPaneView.tsx:62-71`) only ever move for a reported IME
height. That is correct for hardware keyboards (lift 0) *but*
`terminal-webview-html.ts` `emitKeyboardAvoidanceMetrics` and the reduce logic in
`terminal-viewport-refit-state.ts:52-92` keep a `keyboardVisible` flag from
the same events; nothing resets it if a soft keyboard was open when the user
docked the phone (DeX hides the IME without a `keyboardDidHide` in some
Samsung builds), leaving `pending` refits deferred forever (S2 after docking
mid-typing).

### R11 — Orientation plugin forces `fullUser`; no `resizeableActivity`

`plugins/android-respect-rotation-lock.js:8,13` writes
`android:screenOrientation="fullUser"` unconditionally. DeX treats activities
with a *restricting* orientation as "fixed-ratio" and opens them in a
phone-proportioned window; `fullUser` is not `unspecified`, and on some One UI
versions it is enough to disable free resize (S6). `android:resizeableActivity`
is not declared anywhere (Android defaults it to `true` for targetSdk ≥ 24,
but Samsung's DeX compatibility heuristics and Android 16's large-screen
compatibility mode both key off the explicit attribute).

### R12 — Edge-to-edge + safe-area in a windowed Activity

Expo SDK 55 builds are edge-to-edge by default; `app/_layout.tsx:163` draws a
light status bar and every screen pads by `useSafeAreaInsets()` (see the 20+
call sites in `app/**` and `src/**`). In a DeX window the system supplies
**zero** top inset and a decor caption bar; the `SafeAreaView edges={['top']}`
wrappers (`app/index.tsx:674`, `[worktreeId].tsx:4356`, …) are fine, but any
code that *adds* a constant on top of the inset (e.g. fill-sheet `topGap`,
`bottom-drawer-fill-height.ts:13`) or subtracts `insets.bottom` from a keyboard
height (`[worktreeId].tsx:4209`) will be computing against a different inset
set after the window moves displays; `react-native-safe-area-context` does
re-emit, so this is a secondary cause (S7) and mostly self-heals once R1 is
fixed.

### R13 — Breakpoints ignore window class / density

`responsive-layout-metrics.ts:4,8` use dp widths (700 / 600) which is the right
unit, but the inputs come from R3. Additionally there is no hysteresis: a
freeform drag oscillating around 700 dp flips `isWideLayout` on every frame,
which remounts the sidebar (`app/h/_layout.tsx:146-160`) and clears the
docked panel (`[worktreeId].tsx:768-772`).

### Checked and ruled out

- No module-scope `Dimensions.get()` anywhere in `app/` or `src/` (grep) —
  the "fixed dims read at module load" class does not apply.
- No `expo-screen-orientation` usage; no `orientation` screen option
  (`_layout.tsx:171-175` comment is accurate).
- `textZoom={100}` and `scalesPageToFit={false}` (`TerminalWebView.tsx:378-381`)
  are correct for DeX.
- Reanimated/gesture-handler drawers measure via `useWindowDimensions`, not a
  one-shot measure — they are covered by R3, not a separate cause.
- The `react-native@0.83.9.patch` in `mobile/patches/` is iOS TextInput
  composition only; unrelated.

---

## 3. Android manifest / config-plugin changes

All of this is delivered by **one new config plugin**,
`mobile/plugins/android-desktop-mode.js`, registered in `app.json` `plugins`
*after* the rotation-lock plugin so it can override it. Keep the rotation-lock
plugin file (its iOS-parity intent is still valid) but narrow it (see 3.4).

### 3.1 `MainActivity` attributes

```xml
<activity android:name=".MainActivity"
  android:configChanges="keyboard|keyboardHidden|orientation|screenSize|smallestScreenSize|screenLayout|uiMode|density|locale|layoutDirection|fontScale|navigation|mcc|mnc"
  android:resizeableActivity="true"
  android:supportsPictureInPicture="false"
  android:windowSoftInputMode="adjustResize"   <!-- unchanged -->
  android:launchMode="singleTask"              <!-- unchanged -->
  android:screenOrientation="fullUser" />      <!-- see 3.4 -->
```

- `density` + `smallestScreenSize` stop the recreation (R1). RN's
  `ReactActivityDelegate.onConfigurationChanged` → `ReactHost.onConfigurationChanged`
  refreshes native layout metrics, but bridgeless RN does not re-emit
  `didUpdateDimensions`; the Activity display-metrics hook does so explicitly.
- `fontScale` is included because DeX exposes a separate font-size setting;
  RN handles it via the same path.
- `resizeableActivity="true"` explicitly (R11).
- Do **not** set `android:maxAspectRatio` / `android:minAspectRatio` (they
  would reintroduce letterboxing in DeX).

### 3.2 `<application>` metadata

```xml
<meta-data android:name="com.samsung.android.keepalive.density" android:value="true" />
<meta-data android:name="com.samsung.android.multidisplay.keep_process_alive" android:value="true" />
<!-- Android 12L+/16 large-screen compat opt-outs -->
<meta-data android:name="android.allow_multiple_resumed_activities" android:value="true" />
<property android:name="android.window.PROPERTY_COMPAT_ALLOW_RESIZEABLE_ACTIVITY_OVERRIDES" android:value="true" />
```

(`<property>` goes inside `<application>`; `AndroidConfig.Manifest` has no
helper for it — the plugin pushes a raw `{ $: {...} }` node onto
`application.property`.) These are harmless on non-Samsung devices.

### 3.3 `expo-build-properties`

No SDK bumps are needed; keep the SDK 55 defaults (see §7). Add nothing to
`expo-build-properties` for this work — the manifest plugin owns it. (If
`android.enableEdgeToEdge`-style keys are ever added, keep edge-to-edge
**on**; turning it off does not help DeX and targetSdk 36 ignores it.)

### 3.4 Rotation-lock plugin fix

`plugins/android-respect-rotation-lock.js` keeps writing `fullUser` (it is the
right phone behaviour). Two additions, both in the new desktop-mode plugin so
the file stays single-purpose:

1. Manifest: nothing else — `fullUser` is acceptable to DeX **once
   `resizeableActivity="true"` is explicit**. Empirically verify (§6 manual
   checklist, item M1). If DeX still opens a fixed-ratio window on the test
   device, fall back to plan B.
2. Plan B (only if M1 fails): a tiny Expo module-less native hook is
   overkill; instead use `expo-build-properties`' Kotlin `MainActivity`
   dangerous mod to add `onCreate`:
   `if (resources.configuration.isDesktopMode()) requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED`
   where `isDesktopMode()` checks `uiMode & UI_MODE_TYPE_MASK == UI_MODE_TYPE_DESK`
   or the Samsung `semDesktopModeEnabled` field via reflection. This is a
   `withMainActivity` mod in the same plugin, guarded behind a plugin option
   `{ desktopUnspecifiedOrientation: true }` so it can be toggled from
   `app.json` without code changes.

---

## 4. React Native layout changes

### 4.1 Window-bounds provider (fixes R3, R13)

New `src/layout/window-bounds.tsx`:

- `WindowBoundsProvider` renders a `flex: 1` `View` with `onLayout` and
  publishes `{ width, height }` through context. Mount it once in
  `app/_layout.tsx` directly inside `RpcClientProvider`, replacing the
  current `styles.root` `View` (keep its `onLayout` splash hook — compose both).
- `useWindowBounds()` returns the measured root size; until the first layout
  it falls back to `useWindowDimensions()` so first render is unchanged.
- `useResponsiveLayout()` (`src/layout/responsive-layout.ts`) switches from
  `useWindowDimensions()` to `useWindowBounds()`. All eight consumers of
  `isWideLayout` are fixed by this one change.
- Add hysteresis in `responsive-layout-metrics.ts`: `getResponsiveLayoutMetrics(width, height, previous?)`
  keeps the previous `isWideLayout` unless the width moved ≥ 24 dp past the
  breakpoint in the other direction. Pure function; unit-tested.
- Replace `useWindowDimensions` with `useWindowBounds` in:
  `RightDrawer.tsx:90`, `mounted-bottom-drawer.tsx:77`,
  `MobileFilePreviewScreen.tsx:49`, `mobile-onboarding.tsx:55`,
  `app/h/_layout.tsx:63` (via `useResponsiveLayout` already),
  `terminal-viewport-refit.ts:207`.
- `terminal-viewport-refit.ts:206-221`: keep the window-dims effect (it covers
  fold/rotate on phones) but source it from `useWindowBounds`, and merge it
  with the frame-width/height effects into a single `layoutEpoch` counter so a
  freeform drag produces one debounced refit, not three.

### 4.2 Terminal WebView refit on resize (fixes R5, R6, R7)

`src/terminal/TerminalWebView.tsx`

- `measureFitDimensions(containerHeight?, containerWidth?)` — add width. The
  frame `onLayout` in `[worktreeId].tsx:4656-4665` already has it; thread
  `terminalFrameWidth` into `useTerminalViewportRefit` (it's in the options,
  `:36`) and pass both to `ref.measureFitDimensions(height, width)` at `:125`
  and `measureViewportOnce` at `[worktreeId].tsx:1302`.
- Forward the RN frame size to the engine on every change:
  `postMessage({ type: 'set-viewport', width, height, dpr: PixelRatio.get() })`
  from a new `setViewport(width, height)` handle method, called from the frame
  `onLayout`. The engine stores it as `rnViewport` and prefers it over
  `window.innerWidth/innerHeight` everywhere (`computeFitScale`, `clampPan`,
  `measureFitDimensions`, `applyTextScale`, `updateScrollIndicator`).
- Keep the 379-line ceiling in `.oxlintrc.json:30-35` by moving the
  imperative-handle body into `src/terminal/terminal-webview-handle.ts`
  (pure factory taking refs); **never** bump `max-lines`.

`src/terminal/terminal-webview-html.ts` (ceiling 1784 lines (`.oxlintrc.json:36-41`) — put new JS in
injected modules like `terminal-webview-reflow-injected.ts`):

- New `terminal-webview-viewport-injected.ts` exporting
  `TERMINAL_VIEWPORT_JS`: `rnViewport` state, `getViewportWidth()/Height()`
  helpers, `set-viewport` handler, and a **DPR observer**:
  `matchMedia('(resolution: ' + devicePixelRatio + 'dppx)')` re-armed on each
  change → on change, call `term._core._renderService?.handleDevicePixelRatioChange?.()`
  if present else toggle the WebGL addon (dispose + re-load via the existing
  `terminal-webview-webgl-recovery-injected.ts` path), then `applyFitScale('dpr')`
  and `notify({ type: 'viewport-changed', innerWidth, innerHeight, dpr })`.
- `window.addEventListener('resize')` (`:1862-1872`) additionally posts
  `viewport-changed`. RN (`terminal-webview-notification-dispatch.ts`) routes it
  to `useTerminalViewportRefit` as a `notifyWebViewViewport(w,h)` event, which
  marks the viewport stale and schedules a refit **only after both** the RN
  frame and the WebView agree on width (±1 px) — this closes the race in R5.
- `applyTextScale` (`:276-297`): stop calling `term.resize()` locally; set
  `fontSize`, then `applyFitScale('text-scale')` and let the RN refit (already
  triggered by `textScale` at `terminal-viewport-refit.ts:224-232`) resize the
  PTY and reflow.
- Engine `measureFitDimensions`: accept `containerWidthPx`; when the passed
  width differs from `innerWidth` by > 1 px, retry (same rAF loop, `:863-886`)
  up to 30 frames before trusting the RN value — the WebView is still
  re-laying out.

`src/terminal/terminal-viewport-refit.ts`

- Debounce: 150 ms while a drag is in progress (layout events < 100 ms apart)
  → extend to 250 ms trailing; cap server `updateViewport` to ≤ 4/s.
- Reset `frameHeightRefitStateRef.keyboardVisible` to `false` when a
  `hardware-keyboard` signal (4.3) arrives or when window width changes by
  > 10 % (an IME cannot do that) — fixes the stuck `pending` state (R10).

### 4.3 Hardware keyboard / no-IME handling (fixes R8, R9, R10)

- New `src/platform/hardware-keyboard.ts`: `useHardwareKeyboardAttached()`
  — Android: `Keyboard.isVisible()` false **and** the last `keyboardDidShow`
  height < 120 dp or never fired, combined with `Platform.constants`
  `uiMode`/`keyboard` from a tiny Expo config-plugin-free read via
  `expo-constants`? None of those expose `Configuration.keyboard`. Use the
  pragmatic heuristic: `hardwareKeyboard = !keyboardVisible && lastImeHeight === 0 && hasReceivedHardwareKeyEvent`,
  where `hasReceivedHardwareKeyEvent` flips true the first time the live input
  sees an `onKeyPress` with `key.length > 1` (arrows, F-keys) or any key event
  while no IME is visible. Pure reducer + test.
- `terminal-live-input.ts:231-248`: take `hardwareKeyboard` into the options;
  when true, never blur/refocus — just `focus()`.
- `[worktreeId].tsx:2160-2165` and `RightDrawer.tsx:114-122`: when the live
  input is focused and `hardwareKeyboard` is true, the `BackHandler` returns
  `true` **after sending `escape`** via the existing special-key path
  (`terminal-live-input.ts:36` id `'escape'`), not `requestLeaveSession()`.
  Leaving the session stays on the header back button. Extract to
  `src/session/session-back-press.ts` (`resolveSessionBackPress({ liveInputFocused, hardwareKeyboard }) → 'send-escape' | 'leave'`).
- Key coverage: RN Android `TextInput.onKeyPress` does not deliver arrows/
  Ctrl. Two-tier plan:
  1. **Now:** document the gap; accessory bar keys keep working.
  2. **Follow-up (separate task):** a `react-native-key-command`-style native
     listener is not available in Expo Go; implement
     `mobile/packages/expo-hardware-keys` (Expo module, `dispatchKeyEvent`
     override in `MainActivity` via `withMainActivity`) that emits raw
     `KeyEvent`s to JS. Out of scope for t2's first pass.
- `keyboardLift` (`[worktreeId].tsx:4206-4216`): unchanged for IME; with
  `hardwareKeyboard` force 0 even if a stale `keyboardHeight` survives.

### 4.4 Breakpoints / wide layout in a window

- `responsive-layout-metrics.ts`: add `windowClass: 'compact' | 'medium' | 'expanded'`
  (Material window-size classes at 600 / 840 dp) and expose it; keep
  `isWideLayout`/`isTabletLayout` semantics unchanged for existing callers.
- `app/h/_layout.tsx`: sidebar rule becomes `windowClass !== 'compact'`
  (currently `isWideLayout`, which requires *both* sides ≥ 600 — in a
  1280×720 DeX window that is fine, but an 800×600 window should collapse
  the sidebar; `minDetailWidth` already enforces it via clamp, so only the
  hysteresis matters).
- `session-panel-host.ts:33-42`: unchanged; `availableWidth` already comes
  from `onLayout`.

### 4.5 Density changes

- `MobileBrowserPane.tsx:355`: include a `dpr` state fed by a
  `Dimensions.addEventListener('change')`-driven `usePixelRatio()` hook
  (`src/platform/use-pixel-ratio.ts`) in the `useMemo` deps.
- Nothing else reads density on the RN side.

---

## 5. File-by-file implementation plan (for t2)

Ordered so each step is shippable; tests listed per step (all `vitest`, node
env, no RN render harness — keep logic in pure modules exactly like the
existing `*-state.ts` / `*-metrics.ts` files).

| # | File | Change | Test |
|---|---|---|---|
| 1 | `mobile/plugins/android-desktop-mode.js` (new) | `withAndroidManifest`: set `configChanges`, `resizeableActivity`, `supportsPictureInPicture="false"`; push the 3 `<meta-data>` + 1 `<property>` into `<application>`; option `desktopUnspecifiedOrientation` → `withMainActivity` Kotlin snippet (plan B, default off) | `mobile/plugins/android-desktop-mode.test.js`: run the plugin against a minimal manifest object (copy the pattern from `plugins/android-respect-rotation-lock.js`), assert attributes and idempotency (running twice yields one meta-data each). Add `plugins/**/*.test.js` to `vitest.config.ts` `include`. |
| 2 | `mobile/app.json` | add `"./plugins/android-desktop-mode.js"` **after** the rotation-lock plugin | covered by 1 (order assertion: desktop plugin must not clobber `screenOrientation`) |
| 3 | `src/layout/window-bounds.tsx` (new), `app/_layout.tsx:162` | provider + hook; wrap root | `src/layout/window-bounds-state.test.ts` for the pure reducer (`resolveWindowBounds({ measured, fallback })`) |
| 4 | `src/layout/responsive-layout-metrics.ts`, `responsive-layout.ts` | hysteresis + `windowClass`; consume `useWindowBounds` | extend `responsive-layout-metrics.test.ts`: oscillation around 700 dp keeps previous class; 800×600 → compact-ish sidebar rule; 1280×720 → expanded |
| 5 | `RightDrawer.tsx:90`, `mounted-bottom-drawer.tsx:77`, `MobileFilePreviewScreen.tsx:49`, `app/mobile-onboarding.tsx:55` | swap to `useWindowBounds` | existing `right-drawer-panel-width.test.ts`, `bottom-drawer-fill-height.test.ts` already cover the pure parts; add a case "windowWidth < displayWidth" to each |
| 6 | `src/terminal/terminal-webview-viewport-injected.ts` (new), `terminal-webview-html.ts` (`:895`, `:353-360`, `:409-424`, `:276-297`, `:863-920`, `:1862-1872`), `terminal-webview-messages.ts` (`set-viewport` command, `viewport-changed` notification) | RN-viewport-first geometry; DPR observer; stop local `term.resize` in `applyTextScale`; width-retry in measure | `terminal-webview-viewport.test.ts` using the existing `terminal-webview-mouse-test-harness.ts` pattern (happy-dom): inject `TERMINAL_VIEWPORT_JS`, feed `set-viewport`, assert `computeFitScale` uses it; simulate `matchMedia` change → `viewport-changed` notify. Extend `terminal-webview-text-zoom.test.ts`: `set-font-scale` no longer calls `term.resize`. |
| 7 | `src/terminal/TerminalWebView.tsx`, `src/terminal/terminal-webview-handle.ts` (new), `terminal-webview-contract.ts` | `measureFitDimensions(height, width)`, `setViewport(w,h)`; move handle factory out to stay under 379 lines | `terminal-webview-contract.test.ts` (shape); `terminal-webview-query-reply.test.ts` unaffected |
| 8 | `src/terminal/terminal-webview-notification-dispatch.ts` | route `viewport-changed` → `onViewportChanged` | extend `terminal-webview-notification-dispatch.test.ts` |
| 9 | `src/terminal/terminal-viewport-refit-state.ts`, `terminal-viewport-refit.ts` | `layoutEpoch` merge; `webview-viewport` event; width-agreement gate; drag-aware debounce; keyboardVisible reset rule | extend `terminal-viewport-refit.test.ts`: (a) RN width 800 + WebView width 720 → no refit; both 800 → refit; (b) 30 layout events in 500 ms → ≤ 2 refits; (c) width change > 10 % clears `keyboardVisible` |
| 10 | `app/h/[hostId]/session/[worktreeId].tsx:1302, :4656-4665, :2506-2522` | pass width to measure; call `setViewport`; wire `onViewportChanged` | covered by 9; keep file under its 5015 ceiling by moving the frame `onLayout` handler into `src/session/use-terminal-frame-layout.ts` |
| 11 | `src/platform/hardware-keyboard.ts` (new), `src/terminal/terminal-live-input.ts:231-248`, `use-terminal-live-input-focus.ts` | heuristic reducer; no blur/refocus when hardware keyboard | `hardware-keyboard.test.ts`; extend `terminal-live-input.test.ts` ("hardware keyboard → focus() only") |
| 12 | `src/session/session-back-press.ts` (new), `[worktreeId].tsx:2160-2165`, `RightDrawer.tsx:114-122` | Esc → send escape when live input focused + hardware keyboard | `session-back-press.test.ts` |
| 13 | `src/platform/use-pixel-ratio.ts` (new), `src/browser/MobileBrowserPane.tsx:355` | DPR-reactive screencast request | extend `browser-screencast-request.test.ts` with a DPR change |
| 14 | `mobile/README.md` | add "Samsung DeX / desktop mode" section: build, manual checklist pointer | — |

Constraints for t2: no `max-lines` bumps or disables (`AGENTS.md`); no new
`helpers/utils` files; all new modules named after the concept they hold;
`pnpm exec tsc --noEmit && pnpm lint && pnpm test` in `mobile/`, then
`pnpm typecheck:node` at the repo root.

---

## 6. Test plan

### 6.1 Unit (vitest, `mobile/`)

Listed per step in §5. Highlights that must exist before merge:

- Plugin: manifest attributes + metadata + idempotency + ordering with the
  rotation plugin.
- `responsive-layout-metrics`: hysteresis; window classes; freeform sizes
  (800×600, 1024×768, 1280×720, 1920×1080 at density 1.0 and 1.5).
- `terminal-viewport-refit-state`: width-agreement gate; drag coalescing;
  keyboardVisible reset.
- Engine viewport module: RN viewport precedence; DPR observer; text-scale no
  longer resizes the grid.
- Hardware-keyboard reducer; back-press resolver; live-input focus.

### 6.2 Manual DeX checklist

Device: Galaxy S23/S24 or Tab S9 (One UI 6+), DeX via HDMI/USB-C dock and via
"DeX on PC"; pair to a desktop Orca on the same LAN; open a worktree session
with one Claude Code TUI and one plain shell tab.

| ID | Step | Pass criteria |
|---|---|---|
| M1 | Launch app in DeX | Opens as a freeform window with resize handles (not a fixed phone-ratio window). If it is fixed, enable plan B (§3.4) and retest. |
| M2 | Drag-resize the window continuously 600→1400 px wide | No remount (route, scroll positions, terminal scrollback preserved); PTY columns follow within ~300 ms of release; ≤ 4 `updateViewport` per second (watch `[fit]` logs); sidebar toggles once, not repeatedly |
| M3 | Maximize / restore (double-click title bar) | Same as M2 in one step; no blank terminal, no stale scale (text fills width, no clipped right edge) |
| M4 | Enter DeX with the app foregrounded on the phone, then exit DeX | App stays on the same route; no splash; terminals reconnect without a full remount; glyphs crisp after each switch (DPR changed) |
| M5 | Hot-plug a monitor with a different DPI / move window phone↔monitor (Multi-display) | No restart; crisp glyphs; browser tab screencast scale correct |
| M6 | Rotate the phone while docked (DeX continues) and undocked | Phone: rotation honours the OS rotation lock (existing behaviour); DeX: window unaffected |
| M7 | Attach Bluetooth/USB keyboard; tap terminal | Caret focuses once (no flicker); typing reaches PTY; `Esc` sends ESC to the TUI and does **not** leave the session; header back still leaves; detaching keyboard and tapping reopens the IME |
| M8 | Open a fill-sheet (New Workspace) and the RightDrawer in an 800×600 window | Sheet ≤ window height with the status-bar gap; drawer width = window − 48 (narrow) or 420 (wide), never wider than the window |
| M9 | Change terminal text size in Settings while in DeX | Grid and PTY agree (no half-width rendering); one refit |
| M10 | Multi-window: place Orca side-by-side with another app, then resize the split | Same criteria as M2 |
| M11 | Android 15/16 tablet desktop windowing (non-Samsung) | M1–M3, M8 pass (same manifest path) |
| M12 | Phone regression: portrait/landscape, fold/unfold (Z Fold), IME open/close, pinch zoom | Unchanged from today |

Capture `adb logcat | grep -E 'ReactNative|\[fit\]'` for M2–M5; an
`ActivityManager: Recreating` / `onDestroy` line during M4/M5 means R1 is not
fixed (check the prebuilt manifest).

---

## 7. APK build plan (this repo)

Mirrors `.github/workflows/mobile-android-release.yml:23-77`.

```bash
cd mobile
pnpm install --frozen-lockfile          # also builds the xterm/mermaid WebView engines (postinstall)
node scripts/prepare-android-release.mjs  # optional: validates app.json version/versionCode
npx expo prebuild --platform android --no-install --clean
#   → android/ is gitignored (.gitignore:/android/); --clean regenerates it so the new plugin's
#     manifest edits are applied. Verify:
grep -n 'configChanges\|resizeableActivity\|keepalive\|keep_process_alive' android/app/src/main/AndroidManifest.xml
cd android
./gradlew assembleDebug      # install with: adb install -r app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease    # output: app/build/outputs/apk/release/*.apk
```

Toolchain (Expo SDK 55 defaults emitted by prebuild; `expo-build-properties`
in `app.json:104-113` overrides nothing relevant — confirm after prebuild in
`android/build.gradle` / `gradle.properties`):

- JDK 17 (CI uses Temurin 17, workflow `:62-66`), Gradle wrapper from the
  template, AGP 8.x.
- `compileSdkVersion` 36, `targetSdkVersion` 36, `minSdkVersion` 24,
  `buildToolsVersion` 36.0.0, NDK 27.x, Kotlin 2.x. Android 16 (API 36)
  is what makes the `resizeableActivity` / large-screen properties matter.
- Hermes on, New Architecture on (`app.json:10`).

Dev-client loop for DeX testing: `pnpm exec expo run:android --device` to the
docked phone (DeX forwards ADB over the dock), then `pnpm start --dev-client`.
Expo Go cannot be used for the manifest changes; every manifest/plugin change
needs a fresh `expo prebuild --clean` + `run:android`.

---

## 8. Open questions (non-blocking)

1. Which symptom class the reporter actually saw — a screenshot or the `[fit]`
   log would let t2 prioritise §5 steps 6–10 (terminal) vs 3–5 (chrome). The
   manifest work (steps 1–2) is required regardless.
2. Whether One UI treats `fullUser` as resize-restricting (M1). Plan B is
   specified but gated off by default.
3. Hardware-key coverage beyond what RN's `TextInput` delivers needs a native
   module (§4.3); scheduled as a follow-up, not part of this fix.

---

## Appendix A — Maximized-window root-surface bug (round 2)

Report (build `0.0.44` / versionCode 13, `dist/orca-mobile-dex-fix.apk`): on a
Galaxy phone in DeX with the Orca window **maximized** on the external
monitor, the app paints a phone-sized block in the top-left corner (sidebar +
session pane + composer, ≈⅓ of the window width, ≈¼ of its height); the rest
of the window is the black root background. Nothing is stretched — it is a
correctly laid-out UI at the wrong size.

### A.1 TL;DR

The React root **does** fill the window. What is small is the
`react-native-screens` `Screen` that expo-router's `<Stack>` puts directly
under the root. `Screen` measures itself in **pixels** on the Android side and
pushes that size into Fabric as **dp** using `PixelUtil.toDIPFromPixel`, and
since RN 0.83 that helper divides by
`DisplayMetricsHolder.getScreenDisplayMetrics().density` — the density of the
**phone's built-in display** (default display, read through the *Application*
context) — while every other part of the pipeline (root layout constraints,
Yoga → pixel mount) uses the **Activity's** density, i.e. the DeX monitor's.
With a phone at ~2.6–3.0× and DeX at ~1.0–1.5×, the Screen's Yoga size comes
out `density_dex / density_phone` ≈ ⅓–½ of the window in each dimension,
anchored at (0,0). It is an upstream RN regression
(facebook/react-native#55659, introduced by commit `1ad2ec099a`, PR #53523,
"replace getWindowDisplayMetrics with getScreenDisplayMetrics", Aug 2025,
first shipped in 0.83; still present on `main` and reported on 0.85), not a
consequence of the round-1 manifest changes — round 1 merely made the window
resizable so the mismatch became visible at monitor size.

### A.2 Mechanism, step by step (file/line evidence, all under `mobile/node_modules`)

Notation: `d_act` = density of the Activity's display (DeX monitor);
`d_app` = density `DisplayMetricsHolder` holds (phone panel).

1. **Root constraints use `d_act` (correct).**
   `react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/ReactSurfaceView.kt:50-86`
   `onMeasure` takes the EXACTLY specs from the DecorView (the full window in
   px) and calls `surface.updateLayoutSpecs(...)`.
   `runtime/ReactSurfaceImpl.kt:178-194` forwards them with
   `context.resources.displayMetrics.density` — `context` is the **Activity**,
   so this is `d_act`.
   `fabric/SurfaceHandlerBinding.kt:37-59` divides the px specs by that density
   → Yoga root = `W_px/d_act × H_px/d_act` dp, and stores
   `pointScaleFactor = d_act` in the surface's `LayoutContext`
   (`ReactAndroid/src/main/jni/react/fabric/SurfaceHandlerBinding.cpp:42-66`).
2. **Mount uses `d_act` (correct).** Every `UpdateLayout` mount item scales the
   Yoga frame by `layoutMetrics.pointScaleFactor`
   (`jni/react/fabric/FabricMountingManager.cpp:388-396`), so the
   `ScreenStack` Android view (flex:1 child of the root) is laid out to the
   full window in px. So far the tree fills the window.
3. **`Screen` reports its size back in dp using `d_app` (wrong).**
   `react-native-screens/android/src/main/java/com/swmansion/rnscreens/ScreenContainer.kt:47-60, 333-341`
   lays every fragment view to its own full size; `ScreenStackFragment.kt:178-203`
   hosts the `Screen` in a MATCH_PARENT `CoordinatorLayout`; then
   `Screen.kt:348-376` (`onLayout`, `changed == true` on every resize) calls
   `dispatchShadowStateUpdate(width_px, height_px, …)` →
   `updateScreenSizeFabric` →
   `android/src/fabric/java/com/swmansion/rnscreens/FabricEnabledViewGroup.kt:34-69`
   `updateState`, which converts with `PixelUtil.toDIPFromPixel(width_px)` and
   sends `{frameWidth, frameHeight}` as Fabric state.
4. **`PixelUtil` divides by the phone density.**
   `react-native/.../uimanager/PixelUtil.kt:61-67`:
   `return value / DisplayMetricsHolder.getScreenDisplayMetrics().density`
   (0.81.2 used `getWindowDisplayMetrics()`; diff of commit `1ad2ec099a`).
   `uimanager/DisplayMetricsHolder.kt:68-84` fills `screenDisplayMetrics` from
   `context.getSystemService(WINDOW_SERVICE).defaultDisplay.getRealMetrics()`,
   and the `context` is always the **ReactApplicationContext** (Application
   context): `runtime/ReactInstance.kt:251` at instance creation and
   `runtime/ReactHostImpl.kt:722-735` on every `onConfigurationChanged`
   (`DisplayMetricsHolder.initDisplayMetrics(currentReactContext)`). For a
   non-Activity context `defaultDisplay` is `Display.DEFAULT_DISPLAY` (the
   phone panel) regardless of which display the Activity is on, so
   `screenDisplayMetrics.density == d_phone` in DeX, and re-initialising on
   config change does not help — it re-reads the same display.
5. **Fabric forces the Screen's Yoga size from that state.**
   `react-native-screens/common/cpp/react/renderer/components/rnscreens/RNSScreenComponentDescriptor.h:35-119`
   `adopt()`: when `frameSize` is non-zero,
   `layoutableShadowNode.setSize({frameSize.width, frameSize.height})`. So the
   Screen node becomes `W_px/d_app × H_px/d_app` dp instead of
   `W_px/d_act × H_px/d_act`; step 2 then multiplies by `d_act`, giving a
   view of `W_px·(d_act/d_app) × H_px·(d_act/d_app)` px at origin (0,0) — concretely
   the `ScreenContentWrapper` (the Screen's Yoga subtree; the `Screen` Android
   view itself is sized by the `CoordinatorLayout` and stays full-size). Every
   descendant (host sidebar, session pane, composer — all `flex:1` /
   `onLayout`-driven) lays out inside that block. The visible
   "phone-sized" block is exactly this; the black area is the root/`ScreenStack`
   background.
6. **Steady state, not a race.** `FabricEnabledViewGroup.updateState` only
   re-sends when the *dp* value moves by ≥0.9, and `Screen.onLayout` only fires
   on px change, so nothing later corrects it; each resize (maximize, restore,
   drag) re-applies the same wrong ratio. It also affects every other consumer
   of `PixelUtil` with the same `d_app/d_act` error: text size
   (`PixelUtil.toPixelFromSP`, `PixelUtil.kt:38-53` → glyphs rendered
   `d_phone/d_dex`× too large for their Yoga frames = the "garbled / clipped
   text" of the original report), `ScreenStackHeaderConfig` header height,
   `react-native-safe-area-context` insets (`SerializationUtils.kt`),
   `RightDrawer`/modal sizing through `Modal`, etc.

### A.3 Why the round-1 changes did not cause it, and what they did change

- `configChanges=density` / `smallestScreenSize` / `screenSize` are **not** the
  trigger. With recreation (pre-round-1 manifest) the new Activity's
  `ReactSurfaceView` still used `d_act` and `DisplayMetricsHolder` still held
  the Application/default-display value, so the ratio would be identical;
  recreation only added the remount/splash/route-reset symptoms (R1). Keep the
  round-1 `configChanges` and the Samsung keep-alive metadata.
- What round 1 changed is that the window is now resizable
  (`resizeableActivity=true`), so the user can maximize and the fixed-ratio
  block is obvious against a 1080p/4K window. The same ratio applies at any
  window size in DeX (a non-maximized window shows the same proportionally
  small block); at phone-window sizes it was previously read as "broken /
  garbled".
- `ReactHostImpl.onConfigurationChanged` (`ReactHostImpl.kt:722-735`) does
  refresh `DisplayMetricsHolder` (flag `enableFontScaleChangesUpdatingLayout`
  defaults to `true`, `internal/featureflags/ReactNativeFeatureFlagsDefaults.kt:70`)
  and calls `requestLayout()` on the surfaces — but from the Application
  context, so the refreshed value is still the phone's.
- Correction to §3.1 of this document: RN bridgeless does **not** re-emit
  `didUpdateDimensions` on configuration change. The only emitters are
  `ReactRootView.onMeasure` (old architecture only, `ReactRootView.java:1009-1015`)
  and `DeviceInfoModule.onHostResume` on a **fontScale** change
  (`modules/deviceinfo/DeviceInfoModule.kt:45-51`). JS `useWindowDimensions()`
  / `PixelRatio.get()` therefore stay stale for the life of the process on a
  window resize or display move. This is harmless for layout because round 1
  moved every consumer to `WindowBoundsProvider` (`onLayout`-driven), but
  `src/platform/use-pixel-ratio.ts` (`Dimensions` `change` listener) will never
  fire on Android and the browser screencast DPR stays the phone's (see A.6 #6).

### A.4 Reproduction (emulator, 2026-08-23)

Reproduced on a stock Android 15 emulator — no Samsung code involved — using
a simulated secondary display whose density differs from the phone's. Setup:
AVD `dex35` (pixel_7 profile, `system-images;android-35;google_apis;arm64-v8a`,
built-in display 1080×2400 @ 420 dpi, density 2.625), overlay display
`1920x1080/160` (density 1.0), `dist/orca-mobile-dex-fix.apk` (0.0.44 / 13)
installed unchanged. Expected ratio `160/420 = 0.381`.

| Case | Activity config (`dumpsys activity top`) | `ReactSurfaceView` | `ScreenContentWrapper` (Screen's Yoga-sized content) |
|---|---|---|---|
| Freeform window on the 160 dpi display (`force_desktop_mode_on_external_displays=1`) | `w412dp h732dp 160dpi`, `mBounds=Rect(754,146-1166,878)` | `0,0-412,732` (fills window) | **`0,0-157,279`** = 412×0.381 × 732×0.381 |
| **Fullscreen (= maximized) on the 160 dpi display** | `w1920dp h1080dp 160dpi`, `mBounds=Rect(0,0-1920,1080)` | `0,0-1920,1080` (fills window) | **`0,0-731,411`** = 1920×0.381 × 1080×0.381 — the reported top-left block |
| Control: phone display (`--display 0`, 420 dpi) | `w411dp h914dp 420dpi` | `0,0-1080,2400` | `0,0-1080,2400` (correct) |

Also observed: `ScreenStackHeaderConfig` is `731×22` in the maximized case
(same ratio), the `Screen` Android view itself stays full-size (it is laid
out by the `CoordinatorLayout`, not Yoga), there is **no** size-compat mode
(`mBounds == mAppBounds == mMaxBounds`, windowing mode `fullscreen`), and
`logcat -s ReactNative ReactNativeJS` shows nothing beyond `Running "main"`
— the pipeline believes everything is fine, which is why there is no error
to grep for. The hierarchy lines come from
`adb shell dumpsys activity top` (view hierarchy with px bounds);
`screencap -d <overlayId>` does not work for overlay displays on this image,
so `dumpsys` is the evidence path t4 should use too.

Implication for the symptom description: the block is *not* "phone-sized";
it is `window × (d_dex / d_phone)`, so it scales with the window. In the
user's photo (≈⅓ width) the phone is ~2.6–3.0× and the DeX monitor ~1.0×.

### A.5 Fix strategy for t4

Goal: make every `PixelUtil` conversion use the density of the display the
**Activity** is on, and keep it that way across configuration changes; then
make sure already-mounted `Screen`s re-send their size once the density is
right. Two layers, both needed:

**Layer 1 (primary, root fix, proven in A.8) — make `DisplayMetricsHolder`
follow the Activity's display.** Step 2 below is the fix; step 1 is optional
hardening. Note that the `PixelUtil` patch *alone* is **not** sufficient:
`windowDisplayMetrics` is also filled from the Application context
(`resources.displayMetrics` of the global config = phone density on the
emulator and on DeX), so reverting upstream's change without step 2 still
yields the wrong density on a secondary display.

1. (Optional) Extend the existing pnpm patch `mobile/patches/react-native@0.83.9.patch`
   (`package.json` `pnpm.patchedDependencies`) with a hunk for
   `ReactAndroid/src/main/java/com/facebook/react/uimanager/PixelUtil.kt`
   that reverts commit `1ad2ec099a` for the three conversions:
   `toPixelFromDIP` (`:22-26`), `toPixelFromSP` (`:43`), `toDIPFromPixel`
   (`:66`) → `DisplayMetricsHolder.getWindowDisplayMetrics()`. This is the
   exact 0.81 behaviour and the change the upstream issue asks for; it is
   Android-only and affects no wire/RPC surface. (`getScreenDisplayMetrics`
   stays in use for `DeviceInfo` constants / `Dimensions.screen`, which is
   what it is meant for.)
2. Keep `windowDisplayMetrics` pointed at the Activity's resources. Add to
   `plugins/android-desktop-mode.js` a `withMainActivity` mod (available from
   `expo/config-plugins`; prefer it over the existing `withDangerousMod`
   string-replace for the orientation hook — both can stay in the same plugin)
   that inserts into `MainActivity.kt` (exact Kotlin that was verified in A.8 is
   reproduced there):
   - an `override fun onConfigurationChanged(newConfig: Configuration)` that
     calls `super.onConfigurationChanged(newConfig)` **first** (so
     `ReactHostImpl.onConfigurationChanged` runs its Application-context
     `initDisplayMetrics` and our override wins afterwards), then
     `DisplayMetricsHolder.setWindowDisplayMetrics(resources.displayMetrics)`
     and `DisplayMetricsHolder.setScreenDisplayMetrics(realMetricsOfThisDisplay())`
     where `realMetricsOfThisDisplay()` is `DisplayMetrics().also { (getSystemService(WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(it); it.scaledDensity = resources.displayMetrics.scaledDensity }`
     — called on the **Activity** so `defaultDisplay` is the Activity's
     display (API 30+ `display` property is equivalent). Both setters are
     public `@JvmStatic` (`DisplayMetricsHolder.kt:37-52`).
   - the same two calls in `onCreate` **before** `super.onCreate(null)`:
     `ReactInstance.kt:251` uses `initDisplayMetricsIfNotInitialized`, which
     is a no-op once `screenDisplayMetrics` is set, so a cold start in DeX
     (or on any secondary display) initialises from the Activity's display
     instead of the phone's. Also repeat them in `onResume` (cheap; covers
     the window being moved to another display without a density config
     change, and Samsung's `onConfigurationChanged → onRestart → onStart →
     onResume` relaunch sequence).
   - guard the Kotlin with an `// ORCA_DISPLAY_METRICS` marker for idempotency
     exactly like the `ORCA_DESKTOP_ORIENTATION` block, and add the imports
     (`android.content.res.Configuration`, `android.util.DisplayMetrics`,
     `android.view.WindowManager`, `com.facebook.react.uimanager.DisplayMetricsHolder`).
   Extend `plugins/android-desktop-mode.test.js` to assert the snippet is
   inserted once (run the mod twice → one marker).
3. After the override in `onConfigurationChanged`, force a fresh layout pass:
   `window.decorView.requestLayout()`. For the maximize/restore/drag case the
   px size changes anyway so `Screen.onLayout(changed=true)` fires and
   `updateState` recomputes with the corrected density. The residual case is
   a density-only change with identical px size (practically only
   DeX-enter/exit, where px also change) — acceptable; note it in the README.

**Layer 2 (belt-and-braces, JS-visible) — keep the rest of the app honest
about density and dimensions.**

4. JS `Dimensions`/`PixelRatio` never update on Android bridgeless (A.3). In
   the same `MainActivity` hook, after the metrics override, emit the RN
   dimensions event so JS sees the new scale:
   `(reactHost as? ReactHostImpl)?.currentReactContext?.getNativeModule(DeviceInfoModule::class.java)?.emitUpdateDimensionsEvent()`
   (`modules/deviceinfo/DeviceInfoModule.kt:57-77`, public; it diff-checks
   and emits `didUpdateDimensions` → `Dimensions` `change` → `usePixelRatio`).
   If `currentReactContext` is not reachable from Kotlin without reflection
   in this RN version, fall back to dropping the `usePixelRatio` hook's
   dependency on `Dimensions` and instead read the DPR inside the terminal
   WebView (`window.devicePixelRatio`, already observed by the round-1
   `matchMedia` listener in `terminal-webview-viewport-injected.ts`) — the
   browser screencast is the only RN-side consumer.
5. Leave `WindowBoundsProvider` (`src/layout/window-bounds.tsx`) as the source
   of truth for window size — it is correct once Layer 1 lands because the
   Yoga root was always right; only the Screen subtree was wrong.

**Rejected directions (and why):**

- Removing `density` from `configChanges` to force recreation: the recreated
  Activity's `ReactSurfaceView` still uses the Activity density while
  `DisplayMetricsHolder` stays on the Application context → same ratio, plus
  R1 regressions. No.
- Overriding `onConfigurationChanged` to call `updateLayoutSpecs` /
  `requestLayout` alone: the root constraints were never wrong; without
  fixing the `PixelUtil` density the Screen re-sends the same wrong dp. No.
- `android:windowLayoutInDisplayCutoutMode`, `maxAspectRatio`, size-compat
  toggles: the Activity is **not** in size-compat mode (the window is
  resizable, the DecorView measures at full size; `dumpsys activity` shows no
  `mSizeCompatBounds` in the repro). No.
- Reverting to old architecture (`newArchEnabled=false`): `ReactRootView`
  would also re-emit dimensions, but it is a product-wide regression and
  `react-native-screens` 4.x old-arch path has the same `PixelUtil` call
  (`Screen.kt:420-433` → `UIManagerModule.updateNodeSize` in px, but header
  and insets still go through `PixelUtil`). No.
- Waiting for upstream: #55659 was auto-closed by the bot and the commit is
  still on `main`; a patch is the only near-term route. File/upvote upstream
  anyway and link this appendix.

### A.6 File-by-file plan for t4

| # | File | Change |
|---|---|---|
| 1 | `mobile/patches/react-native@0.83.9.patch` (optional) | add `PixelUtil.kt` hunk (3 call sites → `getWindowDisplayMetrics()`); regenerate with `pnpm patch react-native@0.83.9` so the lockfile hash updates; run `pnpm install`. Skip if #2 alone passes A.7 — it does on the emulator (A.8) |
| 2 | `mobile/plugins/android-desktop-mode.js` | new `withMainActivity` mod `withActivityDisplayMetrics` inserting the `ORCA_DISPLAY_METRICS` Kotlin block (`onCreate` pre-super, `onConfigurationChanged` post-super + `requestLayout` + `emitUpdateDimensionsEvent`, `onResume`); keep manifest mod unchanged |
| 3 | `mobile/plugins/android-desktop-mode.test.js` | assert insertion + idempotency of the new block; assert `onConfigurationChanged` calls `super` before `DisplayMetricsHolder` |
| 4 | `mobile/src/platform/use-pixel-ratio.ts` (+ test) | keep; add a comment that Android only fires via the native hook in #2. If #4 of A.5 falls back, replace with WebView-reported DPR |
| 5 | `mobile/app.json` | local verification builds only bumped to `0.0.44-dex2` / `versionCode` 14 so the tester could confirm the install; not part of the upstream change |
| 6 | `mobile/README.md` | DeX section: note the RN #55659 patch and the residual density-only case |
| 7 | this doc | keep Appendix A; fix the §3.1 sentence about `didUpdateDimensions` (A.3) |

Build exactly as §7: `npx expo prebuild --platform android --no-install --clean`
(the Kotlin mod only applies on prebuild; verify
`grep -n ORCA_DISPLAY_METRICS android/app/src/main/java/com/stably/orca/mobile/MainActivity.kt`)
then `./gradlew assembleRelease`; copy to `dist/orca-mobile-dex2.apk`.

### A.7 How t4 verifies on the emulator

Toolchain now present on this machine: `JAVA_HOME=/opt/homebrew/opt/openjdk@17`
(there is no Temurin install; `/usr/libexec/java_home` finds nothing),
`ANDROID_HOME=/opt/homebrew/share/android-commandlinetools` with
`platform-tools`, `emulator`, `platforms;android-35`,
`system-images;android-35;google_apis;arm64-v8a`, AVD `dex35` (pixel_7,
420 dpi). `adb`/`emulator` are **not** on `PATH` — export
`PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH`.

The emulator cannot run Samsung DeX, but the bug only needs *an Activity on
a display whose density differs from the default display*, which stock
Android provides via a simulated secondary display + forced desktop mode:

```bash
export PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH
emulator -avd dex35 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect &
adb wait-for-device; until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done
adb install -r dist/orca-mobile-dex2.apk

# Case 1 — "maximized": fullscreen on a 160 dpi secondary display (phone is 420 dpi).
adb shell settings put global force_desktop_mode_on_external_displays 0
adb shell settings put global overlay_display_devices "1920x1080/160"; sleep 3
D=$(adb shell dumpsys display | grep -o "displayId [0-9]*, displayGroupId" | grep -v "displayId 0," | head -1 | sed -E 's/displayId ([0-9]+).*/\1/')
adb shell am start --display $D -n com.stably.orca.mobile/.MainActivity; sleep 8
adb shell dumpsys activity top | awk '/ACTIVITY com.stably.orca/{p=1} p' \
  | grep -E "mCurrentConfig|ReactSurfaceView|ScreenContentWrapper|ScreenStackHeaderConfig"

# Case 2 — freeform window on that display (desktop mode must be set BEFORE the overlay is created).
adb shell am force-stop com.stably.orca.mobile
adb shell settings put global overlay_display_devices none
adb shell settings put global enable_freeform_support 1
adb shell settings put global force_desktop_mode_on_external_displays 1
adb shell settings put global overlay_display_devices "1920x1080/160"; sleep 3
# re-derive $D (the id changes), start on it, dump as above

# Case 3 — regression control on the phone display.
adb shell am force-stop com.stably.orca.mobile
adb shell am start --display 0 -n com.stably.orca.mobile/.MainActivity; sleep 8   # dump as above
```

Pass criteria (`dumpsys activity top` view hierarchy; `screencap -d` does
**not** work for overlay displays on this image):

- Case 1: `ReactSurfaceView 0,0-1920,1080` **and** `ScreenContentWrapper 0,0-1920,1080`
  (header `1920×22`). Before the fix the wrapper is `0,0-731,411`.
- Case 2: `mCurrentConfig … w412dp h732dp 160dpi`, `ReactSurfaceView 0,0-412,732`
  and `ScreenContentWrapper 0,0-412,732` (before: `157×279`).
- Case 3: everything `0,0-1080,2400`, unchanged from today.
- `adb logcat -s ReactNative ReactNativeJS` shows no
  `Cannot updateRootLayoutSpecs` / `[RNScreens] … differs` lines; text is
  not clipped.

API 35's `am` has no task-resize command, so a *live* maximize/drag of a
running window needs the Android Studio emulator window (desktop mode on,
drag the caption / double-click to maximize) or a Galaxy in DeX; run §6.2
M1–M3 there and confirm the wrapper tracks the window after each resize.

### A.8 Proof-of-fix diagnostic (temporary, reverted)

To de-risk the plan, the Activity-side override was added to the **generated**
`android/app/src/main/java/com/stably/orca/mobile/MainActivity.kt` (gitignored
`android/`; no source file changed, and the edit was reverted afterwards),
built with `./gradlew assembleRelease`, and run on the same emulator. No RN
patch, no JS change:

```kotlin
import android.content.res.Configuration
import android.util.DisplayMetrics
import android.view.WindowManager
import com.facebook.react.uimanager.DisplayMetricsHolder

// in onCreate, before super.onCreate(null):
applyActivityDisplayMetrics()

private fun applyActivityDisplayMetrics() {
  val window = resources.displayMetrics
  val screen = DisplayMetrics()
  @Suppress("DEPRECATION")
  (getSystemService(WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(screen)
  screen.scaledDensity = window.scaledDensity   // DisplayMetricsHolder.initDisplayMetrics does the same
  DisplayMetricsHolder.setWindowDisplayMetrics(window)
  DisplayMetricsHolder.setScreenDisplayMetrics(screen)
}

override fun onConfigurationChanged(newConfig: Configuration) {
  super.onConfigurationChanged(newConfig)   // ReactHostImpl re-inits from the app context first…
  applyActivityDisplayMetrics()             // …then the Activity's display wins
  window.decorView.requestLayout()
}

override fun onResume() {
  super.onResume()
  applyActivityDisplayMetrics()
}
```

Result (`dumpsys activity top`):

| Case | `ReactSurfaceView` | `ScreenContentWrapper` |
|---|---|---|
| Fullscreen on the 160 dpi display, diag build | `0,0-1920,1080` | **`0,0-1920,1080`** (was `731×411`) — header `1920×22` |
| Phone display 0, diag build (regression control) | `0,0-1080,2400` | `0,0-1080,2400` (unchanged) |

A temporary `Log.i("OrcaDiag", …)` confirmed `window=1.0 screen=1.0 1920x1080`
on the secondary display. The `dist/orca-mobile-dex-fix.apk` artifact was not
modified; `android/app/build/outputs/apk/release/app-release.apk` on this
machine currently contains the diagnostic build and will be overwritten by
t4's build.

What the diagnostic did **not** cover (t4 must): a live resize of an already
running window with the metadata path through `onConfigurationChanged`
(freeform drag / maximize without relaunch — the emulator's `am` on API 35 has
no task-resize command; use the Android Studio emulator UI with desktop mode,
or a Galaxy in DeX), DeX enter/exit with `keepalive.density`, and the JS
`didUpdateDimensions` emission (A.5 #4).
