# Android Emulation

## Problem

Orca ships a built-in mobile emulator surface (live pane + `orca emulator` CLI +
agent skill), but it is **iOS Simulator only and macOS only**:

- `src/main/emulator/emulator-availability.ts:32` hard-returns "unavailable" for
  any `platform() !== 'darwin'`, so Windows and Linux users get nothing.
- The backend (`src/main/emulator/emulator-bridge.ts`) is wired directly to
  `serve-sim` (`serve-sim-*.ts`) and `xcrun simctl`
  (`simctl-simulator-devices.ts`), both Apple-only tooling.

Android emulators run on Windows, Linux, and macOS via the Android SDK that
Android Studio installs. We want Android emulation as a first-class peer of the
iOS feature: full AVD lifecycle management, a live ~60fps pane, the full
tap/gesture/type/button/rotate control surface, accessibility tree, app
install/launch, runtime permissions, logcat, plus a dedicated
`orca-emulator-android` agent skill.

## Current architecture (what we reuse vs. replace)

The existing stack already separates a backend from everything above it. The
renderer pane, session registry, RPC/CLI shape, and tab system are effectively
**backend-agnostic** and are reused unchanged:

- **Frame transport is main-owned.** `src/main/ipc/emulator-frame-stream.ts:40`
  runs the MJPEG socket in the main process and forwards raw JPEG bytes to the
  renderer over `emulator:frameStreamFrame`. The renderer
  (`src/renderer/src/components/emulator-pane/use-emulator-frame-stream.ts:74`)
  just wraps each frame in a `Blob`/`<img>`. The renderer is a **frame
  consumer**, decoupled from the source.
- **Per-worktree "active emulator"** lives in
  `src/main/emulator/emulator-session-registry.ts` (like the active browser
  tab). Backend-agnostic.
- **RPC** is declared in `src/main/runtime/rpc/methods/emulator.ts` and
  implemented in `src/main/runtime/orca-runtime-emulator.ts`.
- **CLI** is `src/cli/specs/emulator.ts` + `src/cli/handlers/emulator.ts`.
- **Pane** is `src/renderer/src/components/emulator-pane/**` (~50 files).

What is iOS-bound and needs an Android sibling:

- Device management: `xcrun simctl` → `adb` / `emulator` / `avdmanager`.
- Streaming helper: `serve-sim` (MJPEG/H.264 over HTTP+WS) → `scrcpy-server.jar`
  (H.264 + control over adb-forwarded sockets).
- Input: serve-sim normalized-coord WS → adb-backed Android input commands.
- Availability gate: darwin-only → SDK-present on any OS.

## Goals

- Android emulation on **Windows, Linux, and macOS** (macOS users choose iOS or
  Android in the same pane).
- **Full AVD lifecycle**: discover installed AVDs via the SDK, boot/shutdown
  them from Orca, and attach to already-running emulators + physical `adb`
  devices.
- **Live ~60fps pane** via scrcpy H.264 decoded in the renderer with WebCodecs.
- Control parity: tap, swipe/gesture, type, hardware buttons (Back, Home,
  Recents, Power, Volume), rotate.
- Extra capabilities: accessibility tree (`uiautomator dump`), app
  install/launch (`adb install` / `am start`), runtime permissions
  (`pm grant/revoke/reset`), logcat capture.
- A dedicated `skills/orca-emulator-android/SKILL.md`.

## Non-goals (v1)

- Camera/sensor injection (the Android emulator's virtual-scene path is a much
  larger problem than serve-sim's iOS camera injection; defer).
- Remote/SSH device control (matches the current iOS limitation; emulator
  hardware is local).
- Wear OS / Android TV / Automotive form factors.
- Migrating the iOS backend to H.264 (the interface allows it later; not done
  now).

## Design

### Extract an `EmulatorBackend` interface; make the bridge a router

Today `EmulatorBridge` *is* the iOS implementation. Refactor it into a thin
router over a backend interface so iOS and Android share the session registry,
RPC/CLI shape, frame IPC, and tab system. This is the only change to existing
iOS behavior, and it is a pure extraction (no semantic change).

New module `src/main/emulator/backends/emulator-backend.ts`:

```ts
export type EmulatorBackendKind = 'ios' | 'android'
export type EmulatorStreamCodec = 'mjpeg' | 'h264'

export type EmulatorDevice = {
  backend: EmulatorBackendKind
  id: string            // opaque: simulator UDID, adb serial, or AVD name
  name: string
  state: 'shutdown' | 'booting' | 'booted'
  kind?: string         // form factor / api level, display only
  isAvailable: boolean
}

export type EmulatorBackendCapabilities = {
  install: boolean
  launch: boolean
  permissions: boolean
  accessibilityTree: boolean
  logcat: boolean
}

export interface EmulatorBackend {
  readonly kind: EmulatorBackendKind
  readonly capabilities: EmulatorBackendCapabilities
  isSupportedOnHost(): boolean
  checkAvailability(): Promise<BackendAvailability>
  listDevices(): Promise<EmulatorDevice[]>
  bootDevice(id: string): Promise<EmulatorDevice>
  startSession(id: string): Promise<EmulatorSessionInfo> // includes streamCodec
  tap(id, x, y): Promise<void>
  gesture(id, points): Promise<void>
  type(id, text): Promise<void>
  button(id, name): Promise<void>
  rotate(id, orientation): Promise<void>
  exec(id, command): Promise<unknown>
  // capability-gated:
  installApp?(id, path): Promise<void>
  launchApp?(id, pkg, activity?): Promise<void>
  setPermission?(id, op): Promise<void>
  accessibilityTree?(id): Promise<unknown>
  logcat?(id, opts): Promise<...>
  stopSession(id): Promise<void>
  kill(id): Promise<void>
  shutdown(id): Promise<void>
}
```

- `src/main/emulator/backends/ios-emulator-backend.ts` — the existing serve-sim
  + simctl logic extracted from `EmulatorBridge`, implementing the interface
  with `kind: 'ios'`, `streamCodec: 'mjpeg'`, and capabilities mapped to what
  serve-sim already supports.
- `src/main/emulator/backends/android-emulator-backend.ts` — new, orchestrates
  the Android modules below with `kind: 'android'`, `streamCodec: 'h264'`.
- `EmulatorBridge` keeps its public method names (so RPC/runtime callers don't
  churn) but becomes a router: it holds the available backends, resolves which
  backend owns a given device/session (via the session registry's recorded
  `backend` tag, or by probing `listDevices()` for an unknown id), and
  delegates. The session registry record gains a `backend: EmulatorBackendKind`
  field; `EmulatorSessionInfo` gains `streamCodec`. The existing `deviceUdid`
  field is retained as the opaque `id` to preserve wire-compat across the
  renderer and CLI.

### New Android modules — `src/main/emulator/android/`

Each module is small and single-purpose with a co-located `.test.ts`, matching
the existing `serve-sim-*` / `simctl-*` granularity (no file approaches the
`max-lines` limit):

- `android-sdk-discovery.ts` — resolve the SDK root and the `adb` / `emulator` /
  `avdmanager` binaries from `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then per-OS
  defaults: `%LOCALAPPDATA%\Android\Sdk` (Windows), `~/Library/Android/sdk`
  (macOS), `~/Android/Sdk` (Linux). All paths via `path.join`.
- `adb-devices.ts` — `adb devices -l`, resolve serial, `wait-for-device` +
  `getprop sys.boot_completed` poll, and `wm size` for the device resolution.
- `avd-manager.ts` — `emulator -list-avds`, boot an AVD via a detached
  `emulator @<name>` spawn, shut down via `adb -s <serial> emu kill`.
- `scrcpy-server-deploy.ts` — push the version-pinned `scrcpy-server.jar`, start
  it via `app_process`, and set up the `adb forward` tunnel(s).
- `scrcpy-stream-session.ts` — owns the server process, adb tunnel, and video
  socket lifecycle.
- `scrcpy-video-frame-parser.ts` — read the video socket, parse scrcpy frame headers
  (PTS + length), and emit H.264 access units plus the codec config (SPS/PPS).
- `scrcpy-control-protocol.ts` — encode scrcpy control messages (touch
  down/move/up with pointer id + pressure, inject keycode, inject UTF-8 text,
  scroll, set screen power, rotate, clipboard) for a future low-latency input path.
- `android-input-mapping.ts` — convert normalized 0–1 ↔ device pixels using the
  live frame size; map button names → Android keycodes (BACK=4, HOME=3,
  APP_SWITCH=187, POWER=26, VOLUME_UP=24, VOLUME_DOWN=25).
- `android-input-commands.ts` — current adb-backed tap/type/button/rotate/gesture
  command construction.
- `uiautomator-tree.ts` — `adb shell uiautomator dump` → parsed XML tree.
- `android-app-control.ts` — `adb install <apk>`, `am start` package/activity.
- `android-permissions.ts` — `pm grant` / `revoke` / `reset`.
- `android-logcat.ts` — tail/filter `adb logcat` with bounded buffering.
- `android-availability.ts` — SDK present? AVDs + connected devices list, with
  clear, surfaced messages (mirroring the iOS availability message style).

### Streaming & control data flow

**Control currently uses `adb shell input` commands.** Coordinates stay
normalized 0–1 at every public boundary (CLI, RPC, renderer); the Android backend
maps them to device pixels before issuing adb-backed tap/gesture/button commands.
The scrcpy control protocol encoders are present for a future low-latency input
path, but video streaming does not require that path.

**Video path (H.264 → renderer WebCodecs):**

1. `android-emulator-backend.startSession()` deploys + starts scrcpy-server,
   opens the video + control sockets, and returns `EmulatorSessionInfo` with
   `streamCodec: 'h264'`.
2. `scrcpy-video-stream.ts` reads access units and the SPS/PPS config and pushes
   them over a **new IPC channel** `emulator:videoStream{Start,Config,Frame,Stop}`
   (a sibling of the existing `emulator:frameStream*`), keyed by stream id.
3. New renderer hook
   `src/renderer/src/components/emulator-pane/use-emulator-video-stream.ts`
   feeds the access units to a WebCodecs `VideoDecoder`, drawing decoded
   `VideoFrame`s to a `<canvas>`.
4. `src/renderer/src/components/emulator-pane/emulator-screen-stream-content.tsx`
   branches on `session.streamCodec`: `mjpeg` keeps today's `<img>` path
   untouched; `h264` uses the canvas path. No iOS behavior changes.

## Coordinate & input mapping

- Public API (CLI/RPC/pane gestures) stays normalized 0–1, top-left origin, as
  the iOS path already mandates.
- `android-input-mapping.ts` multiplies by the current device display size before
  adb input commands are built. Rotation changes the effective frame size; the
  mapper reads the current size each gesture rather than caching.
- Hardware buttons: adb keyevents inject keycodes. Android adds
  **Back** and **Recents** (no iOS equivalent); the button name → keycode map
  and the renderer's hardware-button row gain Android variants.

## RPC + CLI surface

Extend `src/main/runtime/rpc/methods/emulator.ts`,
`src/main/runtime/orca-runtime-emulator.ts`, `src/cli/specs/emulator.ts`, and
`src/cli/handlers/emulator.ts`:

- `orca emulator list` gains a **platform column** and shows iOS + Android
  devices/AVDs together; device selection resolves the backend automatically
  (by recorded session tag, else by which backend's `listDevices()` owns the id).
- Existing verbs (`attach`, `tap`, `gesture`, `type`, `button`, `rotate`,
  `exec`, `kill`, `shutdown`) route unchanged to the resolved backend.
- New capability-gated verbs: `install`, `launch`, `permissions`, `ax`,
  `logcat`. On a backend lacking the capability they fail with a clear
  `emulator_unsupported` error rather than silently no-op.
- Existing `--worktree` / `--device` targeting is unchanged.

## Renderer pane

- `src/renderer/src/components/emulator-pane/emulator-phone-hardware-buttons.tsx`
  → Android variant (Back, Home, Recents, Power, Volume) selected by backend
  kind.
- Android device bezel/frame + Android entries (and a "boot AVD" affordance) in
  the attach/list UI.
- `MobileEmulatorAgentSetupGuide*` → Android prerequisites step (install Android
  Studio / SDK, set `ANDROID_HOME`).
- Codec-aware stream content (the canvas path above).
- All UI follows `docs/STYLEGUIDE.md`: existing tokens from
  `src/renderer/src/assets/main.css` and shadcn primitives in
  `src/renderer/src/components/ui/`; no new color/size/shadow values.
- Shortcut labels and any new accelerators use the platform checks required by
  `AGENTS.md` (`CmdOrCtrl`, `⌘`/`Ctrl+`).

## Packaging & dependencies

- Bundle the single, version-pinned `scrcpy-server.jar` (~80 KB) as an app
  resource; wire it into `config/electron-builder.config.cjs` and
  `config/packaged-runtime-node-modules.cjs`. Pin the scrcpy version — the
  server protocol is coupled to the jar.
- Do **not** bundle `adb` / `emulator` / `avdmanager` (large; Android Studio
  installs them). Discover them at runtime and surface a clear setup message if
  the SDK is absent.
- No new runtime npm dependency is required for decode (WebCodecs is built into
  Electron's Chromium). The wasm-decoder fallback (see Risks) would add a dep
  only if the WebCodecs spike fails.

## Skill

New `skills/orca-emulator-android/SKILL.md`, mirroring
`skills/orca-emulator/SKILL.md`:

- Prerequisites: Android Studio / SDK installed, `ANDROID_HOME` (or
  `ANDROID_SDK_ROOT`) set, at least one AVD or a connected device.
- The `orca emulator ...` command table (shared CLI; Android examples).
- Gotchas: Orca handles pixel ↔ normalized conversion (agents always pass 0–1);
  adb device/serial targeting; no camera injection in v1; scrcpy version
  coupling.
- Cross-reference from the iOS skill's "When NOT to use" (which already
  anticipates an Android backend under the same namespace).
- Register it the same way `orca-emulator` is registered.

## Availability & platform gating

`src/main/emulator/emulator-availability.ts` becomes an aggregator that asks
each backend `isSupportedOnHost()` + `checkAvailability()`:

- iOS backend: supported only on `darwin` (unchanged behavior/messages).
- Android backend: supported on any OS where the SDK is discoverable.
- The combined result drives the pane's availability UI; Windows/Linux report an
  available mobile backend for the first time.

## Edge cases

- adb device in `offline` / `unauthorized` state → clear surfaced error, not a
  hang.
- AVD boot timeout (cold boot can take minutes) → bounded wait with a
  cancel/error path; pane shows "booting".
- SDK present but no AVDs and no devices → availability message points to "create
  an AVD in Android Studio".
- Device rotates while a gesture is mid-flight → mapper re-reads frame size per
  event; no cached dimensions.
- Multiple Android devices in one worktree → same "one active per worktree"
  model as iOS; explicit `--device <serial>` for the rest.
- WebCodecs decoder error / key-frame loss → request a new keyframe from scrcpy
  and surface a transient "reconnecting" state (parity with the MJPEG reconnect
  in `mjpeg-frame-stream.ts`).
- Windows path handling for the SDK and the pushed jar uses `path.join` only;
  never assume `/` or `\`.
- App quit / pane close cleans up scrcpy-server, the adb tunnel, and (for managed
  AVDs) the emulator, mirroring `EmulatorBridge.onAppQuit()` /
  `destroyAllSessions()`.

## Test plan

Unit tests (co-located, node Vitest, matching the module's existing test
density):

- `android-sdk-discovery` — env precedence + per-OS default paths (mock env/fs;
  assert Windows/macOS/Linux branches).
- `adb-devices` — parse `adb devices -l` (booted, offline, unauthorized,
  physical), boot-complete polling.
- `avd-manager` — parse `emulator -list-avds`, boot command construction.
- `scrcpy-control-channel` — exact byte encoding of touch/key/text/scroll
  messages.
- `android-input-mapping` — normalized↔pixel round-trips, rotation, keycode map.
- `uiautomator-tree` — XML → tree parsing, including malformed input.
- `android-availability` + `emulator-availability` aggregation — iOS-only,
  Android-only, both, neither.
- backend router resolution in `emulator-bridge` — id → backend, unknown id,
  cross-backend isolation.

Integration tests mock `adb` / `emulator` and the scrcpy sockets the same way
the iOS tests mock serve-sim (`serve-sim-*.test.ts`, `emulator-bridge.test.ts`).

Electron validation (manual, on a machine with the Android SDK):

- Boot an AVD from Orca; confirm the live pane streams and is responsive.
- tap / swipe / type / Back / Home / Recents / rotate.
- `ax`, `install` + `launch`, `permissions grant`, `logcat`.
- Cross-platform smoke on Windows (primary driver) and macOS (iOS + Android
  coexistence).

## Risks / verify-first

- **Electron H.264 WebCodecs decode** — verify in a step-0 spike that an Electron
  renderer `VideoDecoder` decodes scrcpy's H.264. Electron ships proprietary
  codec decode, so this is expected to pass. Fallback if not: a wasm H.264
  decoder (Broadway / tinyh264) or dropping to a main-process H.264→JPEG
  transcode — **neither changes the backend interface**, since the session
  advertises its codec.
- **scrcpy-server protocol is version-coupled** to the bundled jar (same class of
  risk as serve-sim's private SimulatorKit APIs). Pin the version; record it next
  to the bundled jar.
- **adb/emulator environment variance** — offline/unauthorized devices, cold-boot
  timeouts, missing SDK. All handled via explicit, surfaced errors.

## Rollout

1. Step-0 spike: confirm WebCodecs H.264 decode in the Electron renderer.
2. Extract the `EmulatorBackend` interface + `IosEmulatorBackend` (pure
   refactor); keep all iOS tests green.
3. Android device management (`android-sdk-discovery`, `adb-devices`,
   `avd-manager`, `android-availability`) + availability aggregation; surface
   Android devices in `orca emulator list`.
4. scrcpy streaming (`scrcpy-server-deploy`, `scrcpy-video-stream`) + the video
   IPC channel + the renderer WebCodecs canvas path; live pane renders.
5. scrcpy control (`scrcpy-control-channel`, `android-input-mapping`) +
   tap/gesture/type/button/rotate end-to-end.
6. Extra capabilities: `ax`, `install`/`launch`, `permissions`, `logcat`.
7. Renderer polish: Android hardware buttons, bezel, setup guide.
8. Packaging (`scrcpy-server.jar` resource) + the `orca-emulator-android` skill.
9. Tests at each step; typecheck + lint; Electron validation on Windows + macOS.

## Open decisions

- Whether `orca emulator install`/`launch`/`logcat` should also be exposed for
  iOS later (iOS install is `xcrun simctl install`); v1 leaves them
  Android-only via capability flags.
- Whether to expose an explicit `orca emulator boot <avd>` verb vs. folding boot
  into `attach`; initial version folds boot into `attach` (parity with iOS,
  which boots on attach) and adds a `--no-boot` opt-out.
