# Client-display verification harness

Repeatable recipe for verifying client-owned display changes (the
"Client-owned display preferences" effort) on a macOS workstation with Xcode.
The reader is an agent runner — human or automated — on a Mac that has the
`mobile-mcp` / `chrome-devtools` MCP tools available. It substitutes for
re-deriving how to capture before/after evidence for a theme or terminal-render
change.

This harness covers only the JS/TS/CSS display changes of that effort — it does
not verify the native `expo-hardware-keyboard` module shipped alongside it in
the same PR. Every rung below runs without a physical device; the capability is
machine-level: any runner on this Mac with Xcode CLI + a browser MCP can drive
it.

## Artifact convention

All evidence lands under `.verify-orca/<label>/` (gitignored — attach to the PR,
don't commit). `<label>` is the ticket id, e.g. `che-1308`. Light/dark pairs use
the suffixes `-light.png` / `-dark.png`; rung-1 logs use `rung1-<gate>.log`.

## Rung 1 — static + unit gates (any runner, headless)

The repo's own gates. Run the bundle and capture logs:

```bash
node config/scripts/verify-client-display.mjs gates --label <ticket>
```

This runs `pnpm typecheck`, `pnpm test`, and `pnpm lint`, writing each gate's
output to `.verify-orca/<ticket>/rung1-<gate>.log` and printing a pass/fail
summary. Add unit tests for the pure logic a ticket introduces (palette-pair
resolution, device-pref → mode resolution, CSI 997 floor arbitration) so they
run inside `pnpm test`. This rung fully covers the host-side tickets.

## Rung 2 — iOS Simulator light/dark capture (macOS only)

Proven path: plain `simctl`. It needs only Xcode CLI — no WebDriverAgent /
Appium. (`mobile-mcp`'s screenshot path drives WebDriverAgent and times out on a
fresh simulator; use it only when a ticket needs interactive element taps, not
for appearance screenshots.)

```bash
# Boot an iPad sim once (the effort targets iPad):
xcrun simctl boot "iPad Pro 11-inch (M4)"   # or any available iPad
open -a Simulator

# Capture a light/dark pair of whatever is foregrounded on the booted sim:
node config/scripts/verify-client-display.mjs sim-capture --label <ticket>
```

`sim-capture` toggles `simctl ui booted appearance light|dark`, waits for the
repaint, and writes `<label>-light.png` / `<label>-dark.png`. Read the two PNGs
back to confirm the change rendered in both modes.

**Setup cost — the orca mobile dev client (one-time per machine).** A baseline
screenshot of the *actual* app (not the springboard) needs the Expo dev client
built and installed on the simulator:

```bash
cd mobile && pnpm install          # ~35s
pnpm exec expo run:ios             # prebuild → CocoaPods → xcodebuild (~20–30 min, first run)
```

Once installed, JS-only changes hot-reload via `pnpm start` — the native build
is paid once. Until then, `sim-capture` still proves the capture mechanism
against any foregrounded surface.

## Rung 3 — web client light/dark capture

The web client (`pnpm dev:web`, served at `http://127.0.0.1:5173/`) reuses the
desktop renderer. Theme lives in `localStorage` under `orca.web.settings.v1`;
forcing it is `localStorage.setItem('orca.web.settings.v1', '{"theme":"dark"}')`
then reload. Capture light/dark with the `chrome-devtools` MCP (navigate → set
theme → reload → screenshot).

**Setup cost — the web client must be paired to a host.** A bare `pnpm dev:web`
loaded with no pairing fragment crashes on mount (`TypeError: Cannot read
properties of undefined (reading 'app')`) into the renderer-error boundary, so
the theme never applies. Genuine web verification requires a running orca desktop
host to pair the web client against (pairing data carried in the URL fragment).
Stand that host up before treating a rung-3 capture as authoritative; the bare
dev server only proves the chrome-devtools capture tooling, not the app's theme
path.

## Environment prerequisites

- Xcode + an installed iOS simulator runtime (`xcrun simctl list runtimes`).
- Node ≥ 22 (the repo declares 24; 22 runs with an engine warning), `pnpm`.
- `mobile-mcp` and `chrome-devtools` MCP tools available to the runner.
- For the mobile dev-client build: CocoaPods, and the one-time `expo run:ios`.

## Provenance

Baseline established on CHE-1308 against `origin/main`. The `simctl` capture
path and the web/mobile setup costs above were validated empirically on this
machine; the two setup costs are the named obstacles the feature tickets
(CHE-1303 / CHE-1305 mobile, CHE-1307 web) will resolve when they need them.
